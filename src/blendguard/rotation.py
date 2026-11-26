"""World rotation frames shared by the Blender tool and the Scene IR validator."""

import math


def orthonormal_rotation(matrix):
    """Extract a right-handed frame by orthonormalizing the world basis columns."""
    x, y, z = (tuple(matrix[row][column] for row in range(3)) for column in range(3))

    def unit(vector):
        length = math.hypot(*vector)
        if not math.isfinite(length) or length < 1e-12:
            raise ValueError("Target has a singular world transform")
        return tuple(value / length for value in vector)

    def cross(a, b):
        return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

    x = unit(x)
    normal = unit(cross(x, unit(y)))
    if abs(sum(a * b for a, b in zip(normal, unit(z)))) < 1e-12:
        raise ValueError("Target has a singular world transform")
    return tuple(zip(x, cross(normal, x), normal))
