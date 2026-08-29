# D:\MusicDatasets\scripts\test_euclidean_patterns.py
"""
Checks the Bresenham-style pulse distribution against true Bjorklund output.

Both spread k pulses across n steps and both are "even" in a loose sense, but
they are not the same algorithm and disagree for many (k, n) pairs - including
E(3,8), the tresillo, which is the canonical example.
"""

import sys


def bresenham_euclidean(k, n):
    """The accumulator method used in the posted engine."""
    if k <= 0 or n <= 0:
        return [0] * max(n, 0)
    if k >= n:
        return [1] * n

    pattern = []
    step_val = 0
    for _ in range(n):
        step_val += k
        if step_val >= n:
            step_val -= n
            pattern.append(1)
        else:
            pattern.append(0)

    if 1 in pattern:
        first = pattern.index(1)
        pattern = pattern[first:] + pattern[:first]
    return pattern


def bjorklund(k, n):
    """
    True Bjorklund. Recursively pairs remainder groups until the remainder
    count drops below two, which is what produces the maximally even
    distribution the Euclidean rhythm literature describes.
    """
    if k <= 0 or n <= 0 or k > n:
        return [0] * max(n, 0)
    if k == n:
        return [1] * n

    a, b = [[1] for _ in range(k)], [[0] for _ in range(n - k)]

    while len(b) > 1:
        pairs = min(len(a), len(b))
        new_a = [a[i] + b[i] for i in range(pairs)]

        if len(a) > pairs:
            new_b = a[pairs:]
        else:
            new_b = b[pairs:]

        a, b = new_a, new_b
        if len(a) <= 1:
            break

    return [bit for group in (a + b) for bit in group]


def as_str(p):
    return "".join("x" if b else "." for b in p)


def main():
    print("Bresenham accumulator vs true Bjorklund")
    print()

    known = {
        (3, 8): "x..x..x.",      # tresillo
        (5, 8): "x.xx.xx.",      # cinquillo
        (2, 5): "x.x..",
        (3, 4): "x.xx",
        (4, 9): "x.x.x.x..",
        (5, 16): "x..x..x..x..x...",
        (7, 16): "x..x.x.x..x.x.x.",
        (7, 12): "x.xx.x.xx.x.",
    }

    print(f"  {'E(k,n)':>9}  {'bresenham':<18}{'bjorklund':<18}{'reference':<18}{'match?'}")

    mismatches = 0
    for (k, n), reference in known.items():
        br = as_str(bresenham_euclidean(k, n))
        bj = as_str(bjorklund(k, n))

        br_ok = br == reference
        bj_ok = bj == reference

        verdict = []
        if not br_ok:
            verdict.append("bresenham differs")
            mismatches += 1
        if not bj_ok:
            verdict.append("bjorklund differs")

        print(f"  {f'E({k},{n})':>9}  {br:<18}{bj:<18}{reference:<18}"
              f"{'both ok' if not verdict else ', '.join(verdict)}")

    print()
    print(f"  pulse counts are preserved by both methods:")
    for (k, n) in known:
        print(f"    E({k},{n}): bresenham {sum(bresenham_euclidean(k, n))} pulses, "
              f"bjorklund {sum(bjorklund(k, n))} pulses, asked {k}")

    print()
    print("=" * 74)
    print(f"Bresenham disagreed with the reference on {mismatches}/{len(known)} patterns.")
    print()
    print("Both distribute k pulses across n steps and neither is 'broken', but they")
    print("produce different grooves. The docstring's stated example, E(3,8) tresillo")
    print("x..x..x., is Bjorklund output - the accumulator does not generate it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
