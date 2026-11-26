from __future__ import annotations

import math
from typing import Any

from .contracts import EditContract
from .rotation import orthonormal_rotation


AXES = {"x": 0, "y": 1, "z": 2}


def _result(constraint: dict, passed: bool, measured: Any, details: dict | None = None) -> dict:
    return {
        "id": constraint.get("id", constraint.get("type")),
        "type": constraint.get("type"),
        "status": "passed" if passed else "failed",
        "measured": measured,
        "details": details or {},
    }


def _world_location(scene: dict, object_id: str) -> list[float]:
    matrix = scene["objects"][object_id]["world_matrix"]
    return [matrix[0][3], matrix[1][3], matrix[2][3]]


def validate_constraints(before: dict, after: dict, contract: EditContract) -> dict:
    results = []
    for constraint in contract.constraints:
        kind = constraint["type"]
        try:
            if kind == "translation_delta":
                object_id = constraint["target"]
                axis = constraint["axis"]
                index = AXES[axis]
                old_matrix = before["objects"][object_id]["world_matrix"]
                new_matrix = after["objects"][object_id]["world_matrix"]
                axis_vector = [old_matrix[row][index] for row in range(3)]
                length = math.sqrt(sum(value * value for value in axis_vector))
                if length < 1e-12:
                    raise ValueError("Target local axis has a singular world transform")
                direction = [value / length for value in axis_vector]
                world_delta = [new_matrix[row][3] - old_matrix[row][3] for row in range(3)]
                measured = sum(world_delta[row] * direction[row] for row in range(3))
                orthogonal = [world_delta[row] - direction[row] * measured for row in range(3)]
                orthogonal_distance = math.sqrt(sum(value * value for value in orthogonal))
                tolerance = float(constraint.get("tolerance", 0.0005))
                passed = (
                    math.isclose(measured, float(constraint["delta"]), abs_tol=tolerance, rel_tol=0.0)
                    and orthogonal_distance <= tolerance
                )
                result = _result(
                    constraint,
                    passed,
                    measured,
                    {"expected": constraint["delta"], "tolerance": tolerance, "space": "target_local_axis", "orthogonal_distance": orthogonal_distance},
                )
            elif kind == "rotation_delta":
                target = constraint["target"]
                old = orthonormal_rotation(before["objects"][target]["world_matrix"])
                new = orthonormal_rotation(after["objects"][target]["world_matrix"])
                relative = [
                    [sum(a * b for a, b in zip(old_column, new_column)) for new_column in zip(*new)]
                    for old_column in zip(*old)
                ]
                axis = AXES[constraint["axis"]]
                j, k = (axis + 1) % 3, (axis + 2) % 3
                measured = math.degrees(math.atan2(relative[k][j] - relative[j][k], relative[j][j] + relative[k][k]))
                off_axis = math.degrees(math.atan2(math.hypot(relative[j][axis], relative[k][axis]), relative[axis][axis]))
                angle_error = abs(math.remainder(measured - math.remainder(constraint["angle_deg"], 360), 360))
                tolerance = constraint.get("tolerance_deg", 0.05)
                result = _result(constraint, angle_error <= tolerance and off_axis <= tolerance, measured, {
                    "expected_deg": constraint["angle_deg"], "angle_error_deg": angle_error,
                    "off_axis_deg": off_axis, "tolerance_deg": tolerance,
                })
            elif kind == "dimensions_unchanged":
                object_id = constraint["target"]
                old = before["objects"][object_id]["dimensions"]
                new = after["objects"][object_id]["dimensions"]
                tolerance = float(constraint.get("tolerance", 0.0005))
                measured = [new[index] - old[index] for index in range(3)]
                passed = all(abs(value) <= tolerance for value in measured)
                result = _result(constraint, passed, measured, {"tolerance": tolerance})
            elif kind == "object_count_unchanged":
                measured = len(after.get("objects", {}))
                expected = len(before.get("objects", {}))
                result = _result(constraint, measured == expected, measured, {"expected": expected})
            elif kind == "object_count_delta":
                measured = len(after.get("objects", {})) - len(before.get("objects", {}))
                expected = int(constraint["delta"])
                result = _result(constraint, measured == expected, measured, {"expected": expected})
            elif kind == "dimensions_equal":
                measured = after["objects"][constraint["target"]]["dimensions"]
                expected = [float(value) for value in constraint["dimensions"]]
                tolerance = float(constraint.get("tolerance", 0.00001))
                passed = all(math.isclose(a, b, abs_tol=tolerance, rel_tol=0.0) for a, b in zip(measured, expected))
                result = _result(constraint, passed, measured, {"expected": expected, "tolerance": tolerance})
            elif kind == "object_location":
                measured = _world_location(after, constraint["target"])
                expected = [float(value) for value in constraint["location"]]
                tolerance = float(constraint.get("tolerance", 0.00001))
                passed = all(math.isclose(a, b, abs_tol=tolerance, rel_tol=0.0) for a, b in zip(measured, expected))
                result = _result(constraint, passed, measured, {"expected": expected, "tolerance": tolerance, "space": "world"})
            elif kind == "bevel_present":
                modifiers = after["objects"][constraint["target"]]["modifiers"]
                measured = [item for item in modifiers if item["type"] == "BEVEL" and item["name"] == constraint["modifier"]]
                tolerance = float(constraint.get("tolerance", 0.000001))
                passed = len(measured) == 1 and math.isclose(
                    measured[0]["width"], float(constraint["width"]), abs_tol=tolerance, rel_tol=0.0
                ) and measured[0]["segments"] == constraint["segments"]
                result = _result(constraint, passed, measured, {
                    "expected": {"width": constraint["width"], "segments": constraint["segments"]},
                    "tolerance": tolerance,
                })
            elif kind == "material_slot":
                record = after["objects"][constraint["target"]]
                slots = record["mesh"]["material_slot_ids"]
                index = constraint["slot_index"]
                measured = slots[index]
                expected = constraint["material_id"]
                result = _result(constraint, measured == expected, measured, {
                    "expected": expected, "slot_index": index,
                })
            elif kind == "endpoint_distance":
                endpoint = constraint["endpoint"]
                object_id, end = endpoint.rsplit(":", 1)
                point = after["objects"][object_id]["curve"]["world_endpoints"][end]
                target = _world_location(after, constraint["target_port"])
                measured = math.dist(point, target)
                maximum = float(constraint["max_distance"])
                result = _result(constraint, measured <= maximum, measured, {"max_distance": maximum})
            else:
                raise ValueError(f"Unsupported constraint: {kind}")
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            result = _result(constraint, False, None, {"error": str(exc)})
        results.append(result)
    return {
        "status": "passed" if all(item["status"] == "passed" for item in results) else "failed",
        "checks": results,
    }
