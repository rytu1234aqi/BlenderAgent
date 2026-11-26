import unittest

from blendguard.contracts import EditContract, Operation
from blendguard.errors import ContractError


def contract_data():
    return {
        "run_id": "run-test",
        "source_sha256": "a" * 64,
        "instruction": "Move the server",
        "targets": [{"object_id": "obj_server"}],
        "dependencies": [{"object_id": "obj_cable"}],
        "write_set": ["scene.objects.obj_server.local_transform.location"],
        "constraints": [
            {"type": "translation_delta", "target": "obj_server", "axis": "z", "delta": -1.0}
        ],
    }


class ContractTests(unittest.TestCase):
    def test_parses_object_wrappers_and_is_deterministic(self):
        contract = EditContract.from_dict(contract_data())
        self.assertEqual(contract.targets, ["obj_server"])
        self.assertEqual(contract.dependencies, ["obj_cable"])
        self.assertEqual(contract.digest(), EditContract.from_dict(contract.to_dict()).digest())

    def test_rejects_unknown_tool(self):
        with self.assertRaises(ContractError):
            Operation.from_dict({"tool": "execute_python", "arguments": {}})

    def test_rejects_invalid_delta(self):
        data = contract_data()
        data["constraints"][0]["delta"] = float("nan")
        with self.assertRaises(ContractError):
            EditContract.from_dict(data).validate()

    def test_retry_budget_is_bounded(self):
        data = contract_data()
        data["retry_budget"] = 10
        with self.assertRaises(ContractError):
            EditContract.from_dict(data)


if __name__ == "__main__":
    unittest.main()
