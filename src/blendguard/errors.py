class BlendGuardError(Exception):
    """Base error with a stable machine-readable code."""

    code = "BLENDGUARD_ERROR"

    def __init__(self, message: str, *, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "details": self.details,
        }


class ContractError(BlendGuardError):
    code = "SCHEMA_INVALID"


class PermissionDenied(BlendGuardError):
    code = "PERMISSION_DENIED"


class SceneValidationError(BlendGuardError):
    code = "TARGET_CONSTRAINT_FAILED"


class UnauthorizedDifference(BlendGuardError):
    code = "UNAUTHORIZED_DIFF"


class SourceHashChanged(BlendGuardError):
    code = "SOURCE_HASH_CHANGED"


class ToolExecutionError(BlendGuardError):
    code = "TOOL_EXECUTION_FAILED"


class UnsupportedAsset(BlendGuardError):
    code = "UNSUPPORTED_ASSET"


class PlanningError(BlendGuardError):
    code = "PLANNING_FAILED"


class TargetAmbiguous(BlendGuardError):
    code = "TARGET_AMBIGUOUS"


class ConfirmationRequired(BlendGuardError):
    code = "CONFIRMATION_REQUIRED"
