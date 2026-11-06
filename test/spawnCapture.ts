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
    // spawn(file, options) leaves out the argument list.
    const [file, second, third] = args as unknown[];
    const call = Array.isArray(second)
      ? { file: String(file), args: second as string[], options: (third ?? {}) as childProcess.SpawnOptions }
      : { file: String(file), args: [], options: (second ?? {}) as childProcess.SpawnOptions };
    calls.push(call);
    return intercept?.(call) ?? (original as (...a: unknown[]) => childProcess.ChildProcess)(...args);
  });
  return calls;
}
