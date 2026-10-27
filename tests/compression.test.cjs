const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ffmpeg = require('ffmpeg-static');

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function loadConverter({ cancelOnStart = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const module = { exports: {} };
  const electron = {
    app: { isPackaged: false, whenReady: () => ({ then() {} }), on() {} },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../dist/main.js'), 'utf8') + '\nexports.convertOne = convertOne;',
    {
      module, exports: module.exports, process, __dirname,
      require(name) {
        if (name === 'electron') return electron;
        if (name === 'node:child_process') return {
          spawn(binary, args, options) {
            calls.push(args);
            const child = spawn(binary, args, options);
            if (cancelOnStart) child.once('spawn', () => handlers.get('cancel-conversion')());
            return child;
          }
        };
        return require(name);
      }
    }
  );
  return { convert: module.exports.convertOne, batch: handlers.get('convert-videos'), calls };
}

async function fixture(t, duration, audio, compatible = false) {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'compression-test-'));
  t.after(() => fsPromises.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.mov');
  run([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
    '-t', String(duration),
    ...(compatible ? ['-c:v', 'libx264', '-crf', '18'] : ['-c:v', 'mpeg4', '-q:v', '2']),
    ...(audio ? ['-c:a', compatible ? 'aac' : 'pcm_s16le'] : []), input
  ]);
  return { input, output: path.join(dir, 'output.mp4') };
}

function assertDecode(output, audio) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', output, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Video: h264.*640x360.*24 fps/);
  assert.equal(/Audio: aac/.test(result.stderr), audio);
  return fs.statSync(output).size;
}

test('one minute with audio preserves resolution and frame rate while controlling size', async (t) => {
  const { input, output } = await fixture(t, 60, true);
  const converter = loadConverter();
  await converter.convert(input, output, 1, 1, true);
  const bytes = assertDecode(output, true);
  assert.ok(bytes < 60_000_000, `${bytes} bytes exceeds the expected long-video budget`);
  assert.equal(converter.calls.length, 1);
  t.diagnostic(`60 seconds: ${(bytes / 1_000_000).toFixed(2)} MB`);
});

test('silent video converts successfully without an audio stream', async (t) => {
  const { input, output } = await fixture(t, 4, false);
  const converter = loadConverter();
  await converter.convert(input, output, 1, 1, true);
  assertDecode(output, false);
});

test('cancellation stops encoding and removes the partial output', async (t) => {
  const { input } = await fixture(t, 1, false);
  const outputDir = path.join(path.dirname(input), 'cancelled');
  const converter = loadConverter({ cancelOnStart: true });
  const result = await converter.batch(null, { files: [input], outputDir });
  assert.equal(result.cancelled, true);
  assert.equal(result.completed, 0);
  assert.equal(converter.calls.length, 1);
  assert.deepEqual(await fsPromises.readdir(outputDir), []);
});

test('default mode copies video and audio without changing decoded content', async (t) => {
  const { input, output } = await fixture(t, 2, true, true);
  const converter = loadConverter();
  const result = await converter.batch(null, { files: [input], outputDir: path.dirname(output) });
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  const remuxed = result.results[0].outputPath;
  assertDecode(remuxed, true);
  for (const stream of ['0:v:0', '0:a:0']) {
    const hash = (file) => run(['-i', file, '-map', stream, '-f', 'hash', '-']);
    assert.equal(hash(remuxed), hash(input), `${stream} must retain its decoded content`);
  }
});

test('incompatible codecs produce an actionable error and no partial file in default mode', async (t) => {
  const { input } = await fixture(t, 1, true);
  const outputDir = path.join(path.dirname(input), 'incompatible');
  const converter = loadConverter();
  const result = await converter.batch(null, { files: [input], outputDir });
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);
  assert.match(result.results[0].error, /Включите «Сжимать видео»/);
  assert.deepEqual(await fsPromises.readdir(outputDir), []);
  const retry = await converter.batch(null, { files: [input], outputDir, compress: true });
  assert.equal(retry.completed, 1);
  assertDecode(retry.results[0].outputPath, true);
});
