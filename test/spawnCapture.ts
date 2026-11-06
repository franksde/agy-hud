import type { TestContext } from "node:test";
import childProcess from "node:child_process";

export interface SpawnCall {
  file: string;
  args: readonly string[];
  options: childProcess.SpawnOptions;
}

// Records every child_process.spawn call for the rest of the test, then runs the real spawn, unless
// `intercept` returns a stand-in child for that call. The mock is undone when the test ends.
export function captureSpawn(
  t: TestContext,
  intercept?: (call: SpawnCall) => childProcess.ChildProcess | undefined
): SpawnCall[] {
  const calls: SpawnCall[] = [];
  const original = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    const [file, argv, options] = args as unknown as [string, readonly string[], childProcess.SpawnOptions];
    const call = { file, args: argv, options };
    calls.push(call);
    return intercept?.(call) ?? (original as (...a: unknown[]) => childProcess.ChildProcess)(...args);
  });
  return calls;
}
