/**
 * A submission is editable until money or review locks it in. Shared by the
 * server guard and the UI so both agree on when the edit panel is offered.
 */
export function isEditable(request: {
  status: string;
  paidAt: string | null;
  reviewStartedAt: string | null;
}) {
  return request.status === "received" && !request.paidAt && !request.reviewStartedAt;
}
