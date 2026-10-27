const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdir, copyFile, chmod } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Arch } = require('builder-util');

// ffmpeg-static normally installs for the build host, even when Electron is
// packaged for another architecture. Replace it in the staged app before signing.
module.exports = async function packageMacos(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = Arch[context.arch];
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  const pkg = require('ffmpeg-static/package.json');
  const release = pkg['ffmpeg-static']['binary-release-tag'];
  const cacheDir = path.join(tmpdir(), 'video-to-mp4-ffmpeg', release, arch);
  await mkdir(cacheDir, { recursive: true });
  const binary = path.join(cacheDir, 'ffmpeg');
  const install = promisify(execFile);
  const { stdout, stderr } = await install(process.execPath, [require.resolve('ffmpeg-static/install.js')], {
    env: { ...process.env, FFMPEG_BIN: binary, npm_config_platform: 'darwin', npm_config_arch: arch },
    timeout: 300_000
  });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  const destination = path.join(context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources',
    'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  await copyFile(binary, destination);
  await chmod(destination, 0o755);
  for (const suffix of ['README', 'LICENSE']) {
    await copyFile(`${binary}.${suffix}`, `${destination}.${suffix}`);
  }
  console.log(`Bundled FFmpeg for macOS ${arch}`);
};
