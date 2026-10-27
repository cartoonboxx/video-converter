const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

for (const compress of [false, true]) {
  test(`compression option ${compress} reaches the bridge and is locked during conversion`, async () => {
    const elements = new Map();
    function element() {
      return {
        checked: false,
        style: {},
        handlers: {},
        classList: { add() {}, remove() {} },
        addEventListener(name, callback) { this.handlers[name] = callback; },
        append() {}, appendChild() {}
      };
    }
    const document = {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      createElement: element,
      addEventListener() {}
    };
    let finish;
    let requested;
    const videoAPI = {
      onProgress() {},
      async selectVideos() { return ['/input.mov']; },
      async selectOutputDir() { return '/output'; },
      convertVideos(files, outputDir, compression) {
        requested = { files, outputDir, compression };
        return new Promise(resolve => { finish = resolve; });
      }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/renderer.js'), 'utf8'), {
      document, window: { videoAPI }
    });
    await elements.get('#addButton').handlers.click();
    await elements.get('#outputButton').handlers.click();
    const toggle = elements.get('#compressionToggle');
    toggle.checked = compress;
    const conversion = elements.get('#convertButton').handlers.click();
    assert.equal(requested.compression, compress);
    assert.equal(requested.outputDir, '/output');
    assert.equal(toggle.disabled, true);
    finish({ cancelled: false });
    await conversion;
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.checked, compress);

    let bridge;
    let payload;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/preload.js'), 'utf8'), {
      exports: {},
      require() {
        return {
          contextBridge: { exposeInMainWorld(name, api) { bridge = api; } },
          ipcRenderer: { invoke(channel, request) { payload = request; return Promise.resolve(); } }
        };
      }
    });
    await bridge.convertVideos(requested.files, requested.outputDir, requested.compression);
    assert.equal(payload.compress, compress);
    assert.equal(payload.outputDir, '/output');
  });
}
