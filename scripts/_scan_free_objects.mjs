// 漏网自由对象扫描：type:'object' 但既无 properties 又无 additionalProperties（自身或下一非空行）
import fs from 'fs';
function glob(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? glob(dir + '/' + d.name)
      : d.name.endsWith('.mjs') && !d.name.includes('.bak')
        ? [dir + '/' + d.name]
        : [],
  );
}
let bad = 0;
for (const f of glob('tools')) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((ln, i) => {
    if (/^\/\//.test(ln.trim())) return; // 跳过注释行
    if (/type:\s*'object'/.test(ln) && !/additionalProperties/.test(ln) && !/properties/.test(ln)) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t || t.startsWith('//')) continue;
        if (!/^additionalProperties/.test(t) && !/^properties/.test(t)) {
          console.log('LEAK:', f + ':' + (i + 1), '->', t.slice(0, 60));
          bad++;
        }
        break;
      }
    }
  });
}
console.log(bad === 0 ? 'NO LEAKS - all object params declared' : bad + ' leaks remain');
process.exit(bad === 0 ? 0 : 1);
