import type { OutlineChangeRequest } from "@narralume/contracts";
import type { buildApp } from "../src/app.js";

export async function applyOutlineChangeViaApi(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  change: OutlineChangeRequest,
) {
  const preview = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/outline/changes/preview`,
    payload: change,
  });
  if (preview.statusCode !== 200) return preview;
  return app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/outline/changes`,
    payload: { change, previewFingerprint: preview.json().fingerprint },
  });
}
