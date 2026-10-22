import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPendingAction, ACTION_KEY } from "../src/page/actions.js";
export { runPendingAction, ACTION_KEY };

export async function executeActionForTest(actionObj) {
  const cfg = {
    instance: "41694_agent_memory",
    mcpKey: "",
  };
  const options = {
    [ACTION_KEY]: actionObj,
  };
  const r = await runPendingAction(options, cfg);
  return r && r.result ? r.result : r;
}
