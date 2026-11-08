import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FRAMELAB_DEV_URL;

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', error => {
  console.error(`FrameLab could not start: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
