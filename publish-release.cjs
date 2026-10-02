const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const asar = require('@electron/asar');
const pg = require('./server/node_modules/pg');
const dotenv = require('./server/node_modules/dotenv');

dotenv.config({ path: path.join(__dirname, 'server/.env') });

const rootDir = __dirname;
const packageJsonPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Parse command line arguments
// e.g. node publish-release.cjs 1.0.1 "Описание обновления"
const args = process.argv.slice(2);
let newVersion = args[0];
let releaseNotes = args[1] || 'Регулярные улучшения стабильности, голосовой связи и чата.';

if (!newVersion) {
  const parts = pkg.version.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  newVersion = parts.join('.');
}

console.log(`\n==================================================`);
console.log(`🚀 ПУБЛИКАЦИЯ ОБНОВЛЕНИЯ VOICE MESSENGER`);
console.log(`📦 Версия: v${newVersion} (была v${pkg.version})`);
console.log(`📝 Заметки к релизу: "${releaseNotes}"`);
console.log(`==================================================\n`);

async function run() {
  // 1. Update version in package.json files
  pkg.version = newVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('✅ 1/7: package.json обновлен до v' + newVersion);

  // 2. Build Client & Server
  console.log('⏳ 2/7: Сборка фронтенда React и бэкенда TypeScript...');
  execSync('npm --prefix client run build', { stdio: 'inherit', cwd: rootDir });
  execSync('npm --prefix server run build', { stdio: 'inherit', cwd: rootDir });
  console.log('✅ Сборка успешно завершена!');

  // 3. Prepare stage directory and package app.asar
  console.log('⏳ 3/7: Создание компактного пакета app.asar...');
  const stageDir = path.join(rootDir, '.temp_asar_stage');
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  fs.cpSync(path.join(rootDir, 'electron'), path.join(stageDir, 'electron'), { recursive: true });
  fs.cpSync(path.join(rootDir, 'client/dist'), path.join(stageDir, 'client/dist'), { recursive: true });
  fs.cpSync(path.join(rootDir, 'server/dist'), path.join(stageDir, 'server/dist'), { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'server/package.json'), path.join(stageDir, 'server/package.json'));
  fs.copyFileSync(packageJsonPath, path.join(stageDir, 'package.json'));

  const tempAsarPath = path.join(rootDir, 'temp_update.asar');
  await asar.createPackage(stageDir, tempAsarPath);
  fs.rmSync(stageDir, { recursive: true, force: true });

  const asarBuffer = fs.readFileSync(tempAsarPath);
  const asarSizeKb = (asarBuffer.length / 1024).toFixed(1);
  console.log(`✅ app.asar собран! Размер: ${asarSizeKb} КБ (${asarBuffer.length} байт)`);

  // 4. Upload app.asar to Cloud CDN
  console.log('⏳ 4/7: Загрузка app.asar в глобальное облачное CDN-хранилище...');
  let downloadUrl = '';
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    const blob = new Blob([asarBuffer], { type: 'application/octet-stream' });
    form.append('fileToUpload', blob, `app-v${newVersion}.asar`);

    const uploadRes = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: form,
    });
    const urlText = await uploadRes.text();
    if (urlText && urlText.startsWith('http')) {
      downloadUrl = urlText.trim();
      console.log(`✅ Пакет обновления загружен! Прямая ссылка: ${downloadUrl}`);
    } else {
      console.warn('⚠️ Ответ загрузки:', urlText);
    }
  } catch (err) {
    console.error('⚠️ Ошибка загрузки в CDN:', err.message);
  }

  // 5. Publish to Neon.tech PostgreSQL Database
  console.log('⏳ 5/7: Регистрация релиза в облачной базе данных Neon.tech...');
  const dbUrl = (process.env.DATABASE_URL || '').replace('-pooler.', '.');
  if (!dbUrl) {
    throw new Error('DATABASE_URL не найден в server/.env!');
  }

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const now = Date.now();
  // FIX: сохраняем payload_base64 прямо в БД — надёжный источник обновлений без catbox.
  // Лаунчер сначала берёт payload из БД (работает всегда, даже когда CDN заблокирован),
  // и только при отсутствии — качает по download_url.
  const payloadBase64 = asarBuffer.toString('base64');
  console.log(`📦 payload_base64 сохраняется в БД (${(payloadBase64.length / 1024 / 1024).toFixed(1)} МБ base64)...`);
  await client.query(
    `INSERT INTO app_releases (version, download_url, release_notes, payload_base64, timestamp)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (version) DO UPDATE SET
       download_url = EXCLUDED.download_url,
       release_notes = EXCLUDED.release_notes,
       payload_base64 = EXCLUDED.payload_base64,
       timestamp = EXCLUDED.timestamp`,
    [newVersion, downloadUrl || null, releaseNotes, payloadBase64, now]
  );
  await client.end();
  console.log('✅ Релиз (с payload!) успешно записан в таблицу app_releases облачной базы Neon!');

  // 5. Update local unpacked release folder
  console.log('⏳ 5/7: Обновление локальной папки release/win-unpacked...');
  const releaseUnpackedDir = path.join(rootDir, 'release/win-unpacked');
  const releaseResourcesDir = path.join(releaseUnpackedDir, 'resources');
  if (!fs.existsSync(releaseResourcesDir)) fs.mkdirSync(releaseResourcesDir, { recursive: true });

  fs.copyFileSync(tempAsarPath, path.join(releaseResourcesDir, 'app.asar'));
  fs.unlinkSync(tempAsarPath);

  fs.writeFileSync(
    path.join(releaseUnpackedDir, 'version.json'),
    JSON.stringify({ version: newVersion, updated_at: now }, null, 2)
  );

  // 6. Compile VoiceLauncher.exe
  console.log('⏳ 6/7: Компиляция VoiceLauncher.exe c иконкой...');
  const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const iconPath = path.join(rootDir, 'assets/icon.ico');
  const launcherSrc = path.join(rootDir, 'launcher/VoiceLauncher.cs');
  const launcherOut = path.join(releaseUnpackedDir, 'VoiceLauncher.exe');

  execSync(`"${cscPath}" /target:winexe /r:System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.Web.Extensions.dll /win32icon:"${iconPath}" /out:"${launcherOut}" "${launcherSrc}"`, {
    stdio: 'inherit',
    cwd: rootDir,
  });
  console.log('✅ VoiceLauncher.exe успешно собран!');

  // Copy icon.ico into release folder for runtime fallback
  fs.copyFileSync(iconPath, path.join(releaseUnpackedDir, 'icon.ico'));

  // 7. Update Desktop Shortcuts and Zip archive
  console.log('⏳ 7/7: Обновление ярлыков на Рабочем столе и архива VoiceMessenger-Windows.zip...');
  const desktopPath = path.join(process.env.USERPROFILE || 'C:\\Users\\F_Society', 'Desktop');

  // Create/update shortcut for VoiceLauncher
  const psScriptPath = path.join(rootDir, '.temp_shortcut.ps1');
  const psContent = `
$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut('${path.join(desktopPath, 'Voice Launcher.lnk').replace(/'/g, "''")}')
$sc.TargetPath = '${launcherOut.replace(/'/g, "''")}'
$sc.WorkingDirectory = '${releaseUnpackedDir.replace(/'/g, "''")}'
$sc.IconLocation = '${path.join(releaseUnpackedDir, 'icon.ico').replace(/'/g, "''")},0'
$sc.Description = 'Voice Messenger Launcher & Auto-Updater'
$sc.Save()
`;
  fs.writeFileSync(psScriptPath, psContent, 'utf8');
  execSync(`powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`, { stdio: 'ignore' });
  if (fs.existsSync(psScriptPath)) fs.unlinkSync(psScriptPath);

  // Update distribution zip on Desktop
  const zipPath = path.join(desktopPath, 'VoiceMessenger-Windows.zip');
  console.log(`📦 Архивация в ${zipPath}...`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  execSync(`tar -a -c -f "${zipPath}" win-unpacked`, { cwd: path.join(rootDir, 'release') });

  console.log(`\n🎉🎉🎉 ВСЁ ГОТОВО! РЕЛИЗ v${newVersion} ВЫПУЩЕН! 🎉🎉🎉`);
  console.log(`--------------------------------------------------`);
  console.log(`• Размер обновления: ${asarSizeKb} КБ`);
  console.log(`• Облако Neon: Сохранено в базе, доступно отовсюду.`);
  console.log(`• Любой пользователь на любом компьютере открывает VoiceLauncher.exe`);
  console.log(`  и мгновенно скачивает v${newVersion} без ручных действий!`);
  console.log(`• Ярлык на Рабочем столе: "Voice Launcher.lnk"`);
  console.log(`• Архив для друзей: ${zipPath}`);
  console.log(`--------------------------------------------------\n`);
}

run().catch((err) => {
  console.error('\n❌ Ошибка при публикации релиза:', err);
  process.exit(1);
});
