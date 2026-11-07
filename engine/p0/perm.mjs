// KOOK 权限位反解器
// 用法：node perm.mjs 12589056
// 位值来自官方文档 https://developer.kookapp.cn/doc/http/guild-role
const PERMS = {
  0: '管理员',
  1: '管理服务器',
  2: '查看管理日志',
  3: '创建邀请',
  4: '管理邀请',
  5: '频道管理',
  6: '踢出用户',
  7: '封禁用户',
  8: '修改服务器名称',
  9: '管理角色权限',
  10: '管理自定义表情',
  11: '查看文字、语音频道',
  12: '发布消息',
  13: '管理消息',
  14: '上传文件',
  15: '语音链接（= 语音连接 connect）',
  16: '语音管理',
  17: '提及@全体成员',
  18: '添加反应',
  19: '跟随添加反应',
  20: '被动连接语音频道',
  21: '仅使用按键说话',
  22: '使用自由麦',
  23: '说话',
  24: '服务器静音',
  25: '服务器闭麦',
  26: '修改他人昵称',
  27: '播放伴奏',
  28: '屏幕分享',
  29: '回复帖子',
  30: '开启录音',
};

// 这几项是「限制型」：勾上 = 剥夺能力
const RESTRICTIVE = new Set([20, 21, 24, 25]);

// 语音推流真正需要的
const REQUIRED = [
  { bit: 11, name: '查看文字、语音频道' },
  { bit: 15, name: '语音链接（连接语音频道）' },
  { bit: 23, name: '说话' },
  { bit: 22, name: '使用自由麦' },
];

const raw = process.argv[2];
if (!raw) {
  console.error('用法：node perm.mjs <权限数字>   例如 node perm.mjs 12589056');
  process.exit(1);
}

const value = Number(raw);
if (!Number.isFinite(value) || value < 0) {
  console.error(`不是合法数字：${raw}`);
  process.exit(1);
}

const on = [];
for (let bit = 0; bit < 32; bit++) {
  if (value & (1 << bit)) on.push({ bit, name: PERMS[bit] || `未知位 ${bit}` });
}

console.log(`权限值 ${value}（0x${value.toString(16)}）\n`);

console.log(`已勾选 ${on.length} 项：`);
for (const p of on) {
  const tag = RESTRICTIVE.has(p.bit) ? '  ⚠ 限制型！勾上=剥夺能力' : '';
  console.log(`  [位 ${String(p.bit).padStart(2)}] ${p.name}${tag}`);
}

const bad = on.filter((p) => RESTRICTIVE.has(p.bit));
if (bad.length) {
  console.log(`\n⚠ 有 ${bad.length} 个限制型权限被勾上了，这条机器人一定会出问题：`);
  for (const p of bad) console.log(`  · ${p.name}`);
}

const missing = REQUIRED.filter((r) => !(value & (1 << r.bit)));
if (missing.length) {
  console.log(`\n✗ 还缺这 ${missing.length} 项，语音会失败：`);
  for (const m of missing) console.log(`  · ${m.name}  （位 ${m.bit}，值 ${1 << m.bit}）`);
} else {
  console.log('\n✓ 语音推流必需的 4 项权限都在。');
}
