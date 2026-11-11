// Reuse electron-builder's own NSIS reader to extract the generated uninstaller.
// This avoids executing an intermediate installer during build, which fails in
// restricted Windows build hosts. Dependency files remain unchanged.
const { WineVmManager } = require('app-builder-lib/out/vm/WineVm.js');
const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil.js');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const original = WineVmManager.prototype.execWine;
WineVmManager.prototype.execWine = async function (request) {
  if (process.platform === 'win32' && request.options?.env?.__COMPAT_LAYER === 'RunAsInvoker') {
    const path = require('node:path');
    const file = request.file;
    const output = path.join(path.dirname(file), `${path.basename(file, 'exe')}__uninstaller.exe`);
    await UninstallerReader.exec(file, output);
    return '';
  }
  return original.call(this, request);
};
const { build, Platform } = require('electron-builder');
const target = process.argv[2] || 'nsis';
const arch = process.argv.includes('--arm64') ? 'arm64' : 'x64';
const releaseDir = path.resolve(__dirname, '../release');
// 发布目录只保留当前构建结果，避免旧产品名和旧图标混在一起。
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
build({ targets: Platform.WINDOWS.createTarget(target, arch === 'arm64' ? 3 : 1), publish: 'never' })
  .then(() => {
    if (target === 'nsis' && arch === 'x64') {
      const version = require('../package.json').version;
      const installer = path.resolve(__dirname, `../release/Codex-Model-Bridge-Setup-${version}-win-x64.exe`);
      if (process.platform === 'win32' && fs.existsSync(installer)) {
        const parentAcl = execFileSync('icacls.exe', [path.dirname(installer)], { encoding: 'utf8' });
        if (/Mandatory Label\\Low Mandatory Level/i.test(parentAcl))
          execFileSync('icacls.exe', [installer, '/setintegritylevel', 'M'], { stdio: 'inherit' });
      }
    }
  })
  .catch(error => { console.error(error); process.exitCode = 1; });
