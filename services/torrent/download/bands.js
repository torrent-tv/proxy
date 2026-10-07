/** Public selection groups retain both the map's rank and its required time. */
export function compareBands(left, right) {
  return left.urgency - right.urgency || right.priority - left.priority ||
    (left.deadlineAt === right.deadlineAt ? 0 : left.deadlineAt - right.deadlineAt);
}
