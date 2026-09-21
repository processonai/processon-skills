#!/usr/bin/env node
// ProcessOn Skill 内置 base64 编码工具
// 读 stdin 或文件参数 → 输出单行 UTF-8 base64（保留 padding，无折行）
// 用法：
//   echo "内容" | node b64.mjs
//   node b64.mjs < input.txt
//   node b64.mjs input.txt
//   heredoc:  node b64.mjs <<'POB64' ... POB64
import fs from "node:fs";

const encode = (text) => Buffer.from(text, "utf8").toString("base64");

const arg = process.argv[2];
if (arg) {
  // 文件路径模式
  process.stdout.write(encode(fs.readFileSync(arg, "utf8")));
} else {
  // stdin 模式（heredoc / 管道 / 重定向）
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => process.stdout.write(encode(input)));
}
