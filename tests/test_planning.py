import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from blendguard.agent_session import assert_retry_scope
from blendguard.errors import ConfirmationRequired, ContractError, PlanningError, TargetAmbiguous
from blendguard.planning import ClaudePlanner, DeepSeekPlanner, DeterministicPlanner, Proposal, compile_request
from blendguard.scene_ir import data_id_for, object_id_for
from blendguard.scene_summary import load_asset_metadata, summarize_scene


def proposal(action="move_part", target="server_03", confidence=0.99, **parameters):
    values = {
        "axis": None, "delta": None, "angle_deg": None, "unit": None, "dimensions_m": None,
        "new_name": None, "world_location_m": None, "bevel_width_m": None,
        "segments": None, "material_query": None,
    }
    values.update(parameters)
    return {"action": action, "target_query": target, "confidence": confidence, "rationale": "test", "parameters": values}


def identity():
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def scene_ir():
    rack = object_id_for("rack", "EMPTY")
    server = object_id_for("server_03")
    port = object_id_for("server_03_port", "EMPTY")
    cable = object_id_for("cable_07", "CURVE")
    camera = object_id_for("Preview_Overview", "CAMERA")
    material = data_id_for("mat", "panel_blue")
    objects = {
        rack: {"name": "rack", "type": "EMPTY", "parent_id": None, "world_matrix": identity(), "dimensions": [0, 0, 0]},
        server: {
            "name": "server_03", "type": "MESH", "parent_id": rack, "world_matrix": identity(),
            "local_transform": {"location": [0, 0, 1.29]}, "dimensions": [0.48, 0.6, 0.0889],
            "modifiers": [], "mesh": {"material_slot_ids": [material]}, "curve": None,
        },
        port: {
            "name": "server_03_port", "type": "EMPTY", "parent_id": server, "world_matrix": identity(),
            "local_transform": {"location": [0.192, -0.342, 0]}, "dimensions": [0, 0, 0],
            "modifiers": [], "mesh": None, "curve": None,
        },
        cable: {
            "name": "cable_07", "type": "CURVE", "parent_id": None, "world_matrix": identity(),
            "local_transform": {"location": [0, 0, 0]}, "dimensions": [0.3, 0.1, 0.6],
            "modifiers": [], "mesh": None,
            "curve": {"splines": [{"points": [{"co": [0, 0, 0, 1]}] * 4}], "world_endpoints": {"start": [0, 0, 0], "end": [0, 0, 0]}},
        },
        camera: {
            "name": "Preview_Overview", "type": "CAMERA", "parent_id": None,
            "world_matrix": identity(), "dimensions": [0, 0, 0], "modifiers": [], "mesh": None, "curve": None,
        },
    }
    for record in objects.values():
        if "local_transform" not in record:
            record["local_transform"] = {"location": [0, 0, 0]}
    server_02 = copy.deepcopy(objects[server])
    server_02["name"] = "server_02"
    server_02["local_transform"]["location"][2] = 0.99
    objects[object_id_for("server_02")] = server_02
    return {
        "blender_version": "4.4.3", "unit_settings": {"system": "METRIC", "scale_length": 1},
        "objects": objects, "materials": {material: {"name": "panel_blue"}}, "coverage_notes": [],
    }


def summary():
    return summarize_scene(scene_ir(), {
        "rack_unit_m": 0.04445,
        "connections": [{"cable": "cable_07", "end": "end", "port": "server_03_port", "target": "server_03"}],
    })


_VALID_DEEPSEEK_CONTENT = object()


def deepseek_response(content=_VALID_DEEPSEEK_CONTENT, finish_reason="stop"):
    if content is _VALID_DEEPSEEK_CONTENT:
        content = json.dumps(proposal())
    elif isinstance(content, (dict, list)):
        content = json.dumps(content)
    return types.SimpleNamespace(
        choices=[types.SimpleNamespace(
            finish_reason=finish_reason,
            message=types.SimpleNamespace(content=content),
        )],
        model="deepseek-flash",
        id="req_deepseek_test",
    )


class FakeDeepSeekClient:
    def __init__(self, response=None, error=None):
        self.kwargs = None

        def create(**kwargs):
            self.kwargs = kwargs
            if error is not None:
                raise error
            return response or deepseek_response()

        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))


class PlanningTests(unittest.TestCase):
    def compile(self, data, **kwargs):
        return compile_request("test instruction", data, summary(), "asset.blend", "a" * 64, "test", **kwargs)

    def test_move_generates_contract_and_last_curve_control_point(self):
        request = self.compile(proposal(axis="z", delta=-1, unit="U"))
        operations = request["operations"]
        self.assertEqual([item["tool"] for item in operations], ["move_part", "move_curve_endpoint"])
        self.assertAlmostEqual(operations[0]["arguments"]["delta"], -0.04445)
        cable = object_id_for("cable_07", "CURVE")
        self.assertIn(f"scene.objects.{cable}.curve.splines.0.points.3.co", request["contract"]["write_set"])
        self.assertEqual(request["contract"]["constraints"][-1]["type"], "endpoint_distance")
        self.assertIn(f"scene.objects.{object_id_for('Preview_Overview', 'CAMERA')}", request["contract"]["freeze_set"])

    def test_resize_fills_unchanged_dimensions_from_snapshot(self):
        request = self.compile(proposal("set_dimensions", dimensions_m=[0.5, None, None]))
        arguments = request["operations"][0]["arguments"]
        self.assertEqual(arguments["dimensions"], [0.5, 0.6, 0.0889])
        self.assertEqual(request["contract"]["constraints"][0]["type"], "dimensions_equal")

    def test_duplicate_has_new_identity_world_position_and_count_constraints(self):
        request = self.compile(proposal("duplicate_part", new_name="server_05", world_location_m=[0.8, 0, 1.29]))
        new_id = object_id_for("server_05")
        self.assertIn(new_id, request["contract"]["targets"])
        self.assertEqual(request["operations"][0]["arguments"]["offset"], [0.8, 0, 0])
        self.assertEqual(request["contract"]["constraints"][0]["type"], "object_location")
        self.assertEqual(request["contract"]["constraints"][1]["delta"], 2)
        self.assertTrue(request["operations"][0]["arguments"]["include_children"])
        self.assertIn(object_id_for("server_03_port", "EMPTY"), request["operations"][0]["arguments"]["child_names"])

    def test_exact_object_name_cannot_be_overridden_by_alias(self):
        scene_summary = summarize_scene(scene_ir(), {"aliases": {"server_03": "server_02"}})
        request = compile_request(
            "move exact target", proposal(axis="z", delta=-1, unit="U"), scene_summary,
            "asset.blend", "a" * 64, "test",
        )
        self.assertEqual(request["operations"][0]["arguments"]["object_id"], object_id_for("server_03"))

    def test_duplicate_accounts_for_target_parent_inverse_matrix(self):
        scene_summary = summary()
        target = next(item for item in scene_summary["objects"] if item["name"] == "server_03")
        target["matrix_parent_inverse"] = identity()
        target["matrix_parent_inverse"][0][3] = 0.25
        request = compile_request(
            "duplicate", proposal("duplicate_part", new_name="server_05", world_location_m=[0.8, 0, 1.29]),
            scene_summary, "asset.blend", "a" * 64, "test",
        )
        self.assertAlmostEqual(request["operations"][0]["arguments"]["offset"][0], 0.55)
        rack = next(item for item in scene_summary["objects"] if item["name"] == "rack")
        rack["world_matrix"][0][3] = 10.0
        target["matrix_parent_inverse"][0][3] = -10.0
        request = compile_request(
            "duplicate", proposal("duplicate_part", new_name="server_05", world_location_m=[0, 0, 1.29]),
            scene_summary, "asset.blend", "a" * 64, "test",
        )
        self.assertAlmostEqual(request["operations"][0]["arguments"]["offset"][0], 0.0)

    def test_material_query_and_signed_dimensions_are_rejected(self):
        for query in ["", 7]:
            with self.subTest(query=query), self.assertRaises(TargetAmbiguous):
                self.compile(proposal("assign_material", material_query=query))
        parsed, _ = DeterministicPlanner().propose("把 server_02 宽度改为 -0.5 米", summary())
        with self.assertRaises(ContractError):
            self.compile(parsed)

    def test_bevel_generates_modifier_constraint(self):
        request = self.compile(proposal("add_bevel", bevel_width_m=0.002, segments=2))
        self.assertEqual(request["operations"][0]["arguments"]["name"], "BlendGuard Agent Bevel")
        self.assertEqual(request["contract"]["constraints"][0]["type"], "bevel_present")

    def test_material_uses_existing_slot_and_material_id(self):
        request = self.compile(proposal("assign_material", material_query="panel_blue"))
        self.assertEqual(request["operations"][0]["tool"], "assign_material")
        self.assertEqual(request["operations"][0]["arguments"]["material_id"], data_id_for("mat", "panel_blue"))
        self.assertEqual(request["contract"]["constraints"][1]["type"], "material_slot")

    def test_ambiguous_target_never_auto_selects(self):
        with self.assertRaises(TargetAmbiguous) as context:
            self.compile(proposal(target="server", axis="z", delta=-1, unit="U"))
        self.assertEqual(context.exception.code, "TARGET_AMBIGUOUS")

    def test_confirmed_target_must_be_original_candidate(self):
        with self.assertRaises(TargetAmbiguous):
            self.compile(proposal(target="server_03", axis="z", delta=-1, unit="U"), confirmed_target=object_id_for("server_02"))

    def test_low_confidence_requires_explicit_approval(self):
        data = proposal(confidence=0.5, axis="z", delta=-1, unit="U")
        with self.assertRaises(ConfirmationRequired):
            self.compile(data)
        self.assertEqual(self.compile(data, approve_low_confidence=True)["operations"][0]["tool"], "move_part")

    def test_unknown_action_and_arbitrary_code_are_rejected(self):
        with self.assertRaises(PlanningError):
            self.compile(proposal("delete_part"))
        data = proposal(axis="z", delta=-1, unit="U")
        data["python"] = "bpy.ops.wm.quit_blender()"
        with self.assertRaises(PlanningError):
            self.compile(data)
        with self.assertRaises(PlanningError):
            self.compile(proposal(axis="z", delta=-1, unit="U", angle_deg=15))

    def test_protection_comes_from_manifest_and_empty_is_authoritative(self):
        data = proposal(target="server_03", axis="z", delta=-1, unit="U")
        for metadata in ({}, {"protected_objects": []}, {"protected_objects": ["server_03"]}):
            with self.subTest(metadata=metadata):
                snapshot = summarize_scene(scene_ir(), metadata)
                self.assertEqual(snapshot["protected_objects"], metadata.get("protected_objects", []))
                if "protected_objects" not in metadata:
                    snapshot.pop("protected_objects")  # Older hand-crafted summaries.
                args = ("move", data, snapshot, "asset.blend", "a" * 64, "test")
                if metadata.get("protected_objects"):
                    with self.assertRaisesRegex(PlanningError, "protected by the asset manifest"):
                        compile_request(*args)
                else:
                    self.assertEqual(compile_request(*args)["operations"][0]["tool"], "move_part")
        protected_cable = summary() | {"protected_objects": ["cable_07"]}
        with self.assertRaisesRegex(PlanningError, "connected Curve is protected"):
            compile_request("move", data, protected_cable, "asset.blend", "a" * 64, "test")

    def test_asset_metadata_is_bound_to_the_source_and_sidecar_takes_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rack = root / "teaching_rack.blend"
            other = root / "workshop.blend"
            shared = {"source": rack.name, "protected_objects": ["rack", "demo_floor"]}
            (root / "asset_manifest.json").write_text(json.dumps(shared), encoding="utf-8")
            self.assertEqual(load_asset_metadata(rack), shared)
            self.assertEqual(load_asset_metadata(other), {})
            sidecar = {"protected_objects": []}
            rack.with_suffix(".manifest.json").write_text(json.dumps(sidecar), encoding="utf-8")
            self.assertEqual(load_asset_metadata(rack), sidecar)

    def test_rotation_compiles_exact_write_and_keeps_connection(self):
        target = object_id_for("server_03")
        request = self.compile(proposal("rotate_part", axis="x", angle_deg=-45))
        contract = request["contract"]
        self.assertEqual(contract["targets"], [target])
        self.assertEqual(contract["write_set"], [
            f"scene.objects.{target}.local_transform.rotation_euler",
            f"scene.objects.{object_id_for('cable_07', 'CURVE')}.curve.splines.0.points.3.co",
        ])
        self.assertEqual(contract["derived_allowances"], [{"relation": "children_world_transform", "root_object_id": target}])
        self.assertEqual([item["type"] for item in contract["constraints"]], [
            "rotation_delta", "dimensions_unchanged", "object_count_unchanged", "endpoint_distance",
        ])
        self.assertEqual([item["tool"] for item in request["operations"]], ["rotate_part", "move_curve_endpoint"])
        for axis, angle in [("q", 45), ("z", 0), ("x", -361), ("y", float("inf")), ("z", True), ("z", 10**400)]:
            with self.subTest(axis=axis, angle=angle), self.assertRaises(ContractError):
                self.compile(proposal("rotate_part", axis=axis, angle_deg=angle))

    def test_box_compiles_without_existing_target_and_checks_bounds(self):
        params = {"new_name": "box_01", "dimensions_m": [0.2, 0.3, 0.4], "world_location_m": [1, 0, 0.5]}
        new_id = object_id_for("box_01")
        for query in ("", "box_01"):
            request = self.compile(proposal("create_box", query, **params))
            self.assertEqual(request["contract"]["targets"], [new_id])
            self.assertEqual(request["contract"]["write_set"], [f"scene.objects.{new_id}"])
            self.assertEqual([item["type"] for item in request["contract"]["constraints"]], [
                "object_location", "dimensions_equal", "object_count_delta",
            ])
            self.assertEqual(request["operations"][0]["arguments"], {
                "name": "box_01", "dimensions": [0.2, 0.3, 0.4], "location": [1, 0, 0.5],
            })
        for changes in [
            {"new_name": "server_03"}, {"new_name": "a.b"}, {"new_name": "a" * 33},
            {"dimensions_m": [0, 1, 1]}, {"dimensions_m": [20.1, 1, 1]},
            {"dimensions_m": [None, 1, 1]}, {"world_location_m": [80, 80, 0]},
            {"world_location_m": [0, 0, float("nan")]},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                self.compile(proposal("create_box", "", **(params | changes)))
        with self.assertRaises(ConfirmationRequired):
            self.compile(proposal("create_box", "", confidence=0.84, **params))

    def test_non_finite_or_out_of_range_values_are_rejected(self):
        for value in [float("nan"), float("inf"), 100]:
            with self.subTest(value=value):
                with self.assertRaises((ContractError, PlanningError)):
                    self.compile(proposal(axis="z", delta=value, unit="m"))
        with self.assertRaises(ContractError):
            self.compile(proposal("set_dimensions", dimensions_m=[0, 1, 1]))

    def test_unsupported_instruction_cannot_create_request(self):
        with self.assertRaises(PlanningError):
            self.compile(proposal("unsupported"))

    def test_retry_cannot_expand_contract_or_change_target(self):
        original = self.compile(proposal(axis="z", delta=-1, unit="U"))
        replacement = copy.deepcopy(original)
        assert_retry_scope(original, replacement)
        replacement["contract"]["write_set"].append("scene.objects.*")
        with self.assertRaises(PlanningError):
            assert_retry_scope(original, replacement)
        replacement = copy.deepcopy(original)
        replacement["operations"][0]["arguments"]["object_id"] = "obj_other"
        with self.assertRaises(PlanningError):
            assert_retry_scope(original, replacement)

    def test_deterministic_teaching_examples(self):
        parser = DeterministicPlanner()
        cases = [
            ("将 server_03 下移 1U", "move_part"),
            ("把 server_02 宽度改为 0.5 米", "set_dimensions"),
            ("复制 server_02 命名为 server_05，放到 [0.8, 0, 1.2]", "duplicate_part"),
            ("给 server_03 添加 2 毫米倒角", "add_bevel"),
            ("把 server_03 绕 z 轴旋转 15 度", "rotate_part"),
            ("rotate server_03 around X by -15.5 deg", "rotate_part"),
            ("创建长方体 box_01，尺寸 [0.2, 0.3, 0.4]，放到 [1.0, 0, 0.5]", "create_box"),
            ("create box box_01, dimensions [.2, .3, .4], at [1, 0, -.5]", "create_box"),
        ]
        for instruction, action in cases:
            with self.subTest(instruction=instruction):
                data, metadata = parser.propose(instruction, summary())
                self.assertEqual(data["action"], action)
                self.assertIsNone(metadata["model"])
                self.compile(data)

    def test_deepseek_adapter_uses_json_mode_without_execution_tools(self):
        client = FakeDeepSeekClient()
        data, metadata = DeepSeekPlanner(client=client).propose(
            "move server_03 down 1U",
            {"objects": [{"name": "server_03"}]},
            {"code": "TARGET_CONSTRAINT_FAILED", "parameters": {"delta": -1}},
        )
        request = client.kwargs
        self.assertEqual(data["action"], "move_part")
        self.assertEqual(request["model"], "deepseek-flash")
        self.assertEqual(request["response_format"], {"type": "json_object"})
        self.assertFalse(request["stream"])
        self.assertGreaterEqual(request["max_tokens"], 4096)
        for forbidden in ["tools", "tool_choice", "thinking", "output_config", "betas", "fallbacks"]:
            self.assertNotIn(forbidden, request)
        system = request["messages"][0]["content"]
        self.assertIn("json", system)
        self.assertIn("additionalProperties", system)
        self.assertIn("This complete JSON example", system)
        user = request["messages"][1]["content"]
        self.assertIn("server_03", user)
        self.assertIn("move server_03 down 1U", user)
        self.assertIn("TARGET_CONSTRAINT_FAILED", user)
        self.assertEqual(metadata, {
            "planner": "deepseek_json_output",
            "model": "deepseek-flash",
            "request_id": "req_deepseek_test",
        })

    def test_deepseek_rejects_blank_invalid_and_non_object_json(self):
        contents = [None, "", " \n", "not-json", "```json\n{}\n```", []]
        for content in contents:
            with self.subTest(content=content):
                client = FakeDeepSeekClient(response=deepseek_response(content=content))
                with self.assertRaises(PlanningError):
                    DeepSeekPlanner(client=client).propose("move", {"objects": []})

    def test_deepseek_rejects_missing_choices_and_incomplete_responses(self):
        response = deepseek_response()
        response.choices = []
        with self.assertRaises(PlanningError):
            DeepSeekPlanner(client=FakeDeepSeekClient(response=response)).propose("move", {})
        for reason in ["length", "content_filter", None]:
            with self.subTest(reason=reason):
                client = FakeDeepSeekClient(response=deepseek_response(finish_reason=reason))
                with self.assertRaises(PlanningError) as context:
                    DeepSeekPlanner(client=client).propose("move", {})
                self.assertEqual(context.exception.details["finish_reason"], reason)

    def test_deepseek_still_enforces_the_host_proposal_schema(self):
        missing = proposal()
        del missing["rationale"]
        extra = proposal()
        extra["python"] = "bpy.ops.wm.quit_blender()"
        for invalid in [missing, extra]:
            with self.subTest(invalid=invalid):
                client = FakeDeepSeekClient(response=deepseek_response(content=invalid))
                with self.assertRaises(PlanningError):
                    DeepSeekPlanner(client=client).propose("move", {})

    def test_deepseek_api_errors_are_stable_and_do_not_expose_secrets(self):
        cases = [
            (400, "DeepSeek rejected the planning request format"),
            (401, "DeepSeek authentication failed; check DEEPSEEK_API_KEY"),
            (402, "DeepSeek account has insufficient balance"),
            (422, "DeepSeek rejected the planning request parameters"),
            (429, "DeepSeek rate limit exceeded"),
            (500, "DeepSeek service is unavailable"),
            (503, "DeepSeek service is unavailable"),
            (None, "DeepSeek planning request failed"),
        ]
        for status, expected in cases:
            with self.subTest(status=status):
                error = RuntimeError("sensitive request sk-test-secret and response body")
                error.status_code = status
                with self.assertRaises(PlanningError) as context:
                    DeepSeekPlanner(client=FakeDeepSeekClient(error=error)).propose("move", {})
                self.assertEqual(context.exception.message, expected)
                serialized = json.dumps(context.exception.to_dict())
                self.assertNotIn("sk-test-secret", serialized)
                self.assertNotIn("response body", serialized)

    def test_deepseek_requires_its_own_nonblank_credential(self):
        for environment in [{"OPENAI_API_KEY": "other-provider-key"}, {"DEEPSEEK_API_KEY": "  "}]:
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True):
                with self.assertRaises(PlanningError) as context:
                    DeepSeekPlanner().propose("move", {})
                self.assertIn("DEEPSEEK_API_KEY", context.exception.message)

    def test_deepseek_missing_sdk_is_an_explicit_failure(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key"}, clear=True):
            with patch.dict(sys.modules, {"openai": None}):
                with self.assertRaises(PlanningError) as context:
                    DeepSeekPlanner().propose("move", {})
                self.assertIn("openai", context.exception.message)

    def test_deepseek_lazy_client_uses_official_defaults_and_custom_base_url(self):
        for configured, expected in [(None, "https://api.deepseek.com"), ("https://deepseek.example/v1", "https://deepseek.example/v1")]:
            with self.subTest(configured=configured):
                captured = {}
                fake_client = FakeDeepSeekClient()
                module = types.ModuleType("openai")

                def factory(**kwargs):
                    captured.update(kwargs)
                    return fake_client

                module.OpenAI = factory
                environment = {"DEEPSEEK_API_KEY": "sk-test-secret"}
                if configured:
                    environment["DEEPSEEK_BASE_URL"] = configured
                with patch.dict(os.environ, environment, clear=True), patch.dict(sys.modules, {"openai": module}):
                    _, metadata = DeepSeekPlanner().propose("move", {})
                self.assertEqual(captured["api_key"], "sk-test-secret")
                self.assertEqual(captured["base_url"], expected)
                self.assertEqual(captured["max_retries"], 0)
                self.assertGreater(captured["timeout"], 0)
                self.assertNotIn("sk-test-secret", json.dumps(metadata))

    def test_deepseek_model_precedence(self):
        with patch.dict(os.environ, {"DEEPSEEK_MODEL": "provider-model", "BLENDGUARD_MODEL": "generic-model"}, clear=True):
            self.assertEqual(DeepSeekPlanner().model, "provider-model")
            self.assertEqual(DeepSeekPlanner(model="explicit-model").model, "explicit-model")
        with patch.dict(os.environ, {"BLENDGUARD_MODEL": "generic-model"}, clear=True):
            self.assertEqual(DeepSeekPlanner().model, "generic-model")
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(DeepSeekPlanner().model, "deepseek-flash")

    def test_claude_adapter_uses_structured_output_without_execution_tools(self):
        class MessageAPI:
            def __init__(self):
                self.kwargs = None

            def create(self, **kwargs):
                self.kwargs = kwargs
                text = type("Text", (), {"type": "text", "text": __import__("json").dumps(proposal())})()
                return type("Response", (), {
                    "stop_reason": "end_turn", "content": [text], "model": "claude-opus-5-5", "_request_id": "req_test",
                })()

        messages = MessageAPI()
        client = type("Client", (), {"beta": type("Beta", (), {"messages": messages})()})()
        data, metadata = ClaudePlanner(client=client).propose("move server_03", {"objects": []})
        self.assertEqual(data["action"], "move_part")
        self.assertNotIn("tools", messages.kwargs)
        self.assertEqual(messages.kwargs["output_config"]["format"]["type"], "json_schema")
        self.assertEqual(messages.kwargs["thinking"], {"type": "adaptive"})
        self.assertEqual(metadata["request_id"], "req_test")


if __name__ == "__main__":
    unittest.main()
