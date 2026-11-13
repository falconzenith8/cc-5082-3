import { runInstance, describeListenError } from './runtime.js';

try {
  await runInstance();
} catch (error) {
  const detail = describeListenError(error);
  console.error(`启动失败 [${detail.code}]：${detail.message}`);
  process.exitCode = 1;
}
