export function renderLeavePanel(requests) {
  return requests.map((request) => `${request.id}: ${request.status}`).join("\n");
}
