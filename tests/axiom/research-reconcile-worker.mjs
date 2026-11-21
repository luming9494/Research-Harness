// 在原生账本提交后、监管器收到授权前暂停，供父进程强杀。
import { basename } from "node:path";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { adapter, specFor } from "../../axiom/research/environment.ts";
import { loadPlan } from "../../axiom/research/execute.ts";

const [root, sha, python, status] = process.argv.slice(2);
const plan = await loadPlan(root, sha);
const repo = process.cwd();
const task = await TaskController.create(repo, python, specFor(plan, sha, 1), () => {}, {
  approval: { sessionId: plan.id, approvedAt: new Date().toISOString() },
  open: async (directory) => {
    const ledger = await openExperimentLedger(directory);
    return { ...ledger, async save(state) {
      await ledger.save(state);
      const op = state.commands.at(-1);
      if (op?.reservation && op.status === status) {
        process.stdout.write(`${JSON.stringify({ task: basename(directory), op })}\n`);
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    } };
  },
}, adapter({ repo, python }, plan));
await task.invoke("baseline", {}, AbortSignal.timeout(90_000));
