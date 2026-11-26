import json
from pathlib import Path
import tempfile
import unittest

from blendguard.agent_session import execute_agent_plan
from blendguard.errors import PlanningError
from blendguard.planning import DeterministicPlanner
from blendguard.workspace import write_json

from tests.test_planning import proposal, summary


class SequencePlanner:
    name = "test_sequence"

    def __init__(self, proposals):
        self.proposals = iter(proposals)
        self.calls = 0

    def propose(self, instruction, scene, feedback=None):
        self.calls += 1
        return next(self.proposals), {"planner": self.name, "model": None}


class AgentSessionTests(unittest.TestCase):
    def test_failed_attempt_is_not_committed_and_numeric_retry_reuses_original_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "run"
            first = proposal(axis="z", delta=-1, unit="U")
            corrected = proposal(axis="z", delta=-1, unit="U")
            planner = SequencePlanner([corrected])
            runner_calls = []

            def runner(request):
                runner_calls.append(request)
                attempt_dir = Path(request["run_dir"])
                if len(runner_calls) == 1:
                    return 2, {
                        "status": "ROLLED_BACK", "reason": "VALIDATION_FAILED",
                        "targets": {"status": "failed"}, "locality": {"status": "passed"},
                    }
                for name in ["input", "reports", "export", "delivery"]:
                    (attempt_dir / name).mkdir(parents=True, exist_ok=True)
                result = {"status": "COMMITTED", "run_id": request["contract"]["run_id"]}
                write_json(attempt_dir / "result.json", result)
                write_json(attempt_dir / "delivery" / "quality_report.json", result)
                return 0, result

            report = execute_agent_plan(
                planner, "move", summary(), root / "source.blend", "a" * 64, run_dir, runner,
                confirmed_target=None, approve_low_confidence=False, export=False, retry_budget=1,
                initial_plan=(first, {"planner": "test", "model": None}),
            )
            self.assertEqual(report["status"], "COMMITTED")
            self.assertEqual(len(runner_calls), 2)
            self.assertEqual(planner.calls, 1)
            self.assertFalse((run_dir / "attempts" / "attempt_001" / "delivery" / "output.blend").exists())
            self.assertTrue((run_dir / "delivery" / "quality_report.json").exists())
            self.assertEqual(
                runner_calls[0]["contract"]["constraints"], runner_calls[1]["contract"]["constraints"],
            )

    def test_unauthorized_difference_never_automatically_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            planner = SequencePlanner([])

            def runner(request):
                return 2, {
                    "status": "ROLLED_BACK", "reason": "VALIDATION_FAILED",
                    "targets": {"status": "passed"}, "locality": {"status": "failed"},
                }

            report = execute_agent_plan(
                planner, "move", summary(), root / "source.blend", "a" * 64, root / "run", runner,
                confirmed_target=None, approve_low_confidence=False, export=False, retry_budget=2,
                initial_plan=(proposal(axis="z", delta=-1, unit="U"), {"planner": "test", "model": None}),
            )
            self.assertEqual(report["status"], "FAILED")
            self.assertEqual(len(report["attempts"]), 1)
            self.assertEqual(planner.calls, 0)
            self.assertFalse((root / "run" / "delivery").exists())
    def test_retry_planning_exception_still_writes_final_failure_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            class FailingPlanner:
                def propose(self, instruction, scene, feedback=None):
                    raise PlanningError("retry planning failed")

            def retryable_runner(request):
                return 2, {
                    "status": "ROLLED_BACK", "reason": "VALIDATION_FAILED",
                    "targets": {"status": "failed"}, "locality": {"status": "passed"},
                }

            run_dir = root / "run"
            report = execute_agent_plan(
                FailingPlanner(), "move", summary(), root / "source.blend", "a" * 64, run_dir,
                retryable_runner, confirmed_target=None, approve_low_confidence=False,
                export=False, retry_budget=1,
                initial_plan=(proposal(axis="z", delta=-1, unit="U"), {"planner": "test", "model": None}),
            )
            self.assertEqual(report["status"], "FAILED")
            self.assertEqual(len(report["attempts"]), 2)
            self.assertEqual(report["attempts"][-1]["error"]["code"], "PLANNING_FAILED")
            self.assertTrue((run_dir / "result.json").is_file())
            self.assertTrue((run_dir / "reports" / "agent_plan.json").is_file())
            self.assertFalse((run_dir / "delivery").exists())


if __name__ == "__main__":
    unittest.main()
