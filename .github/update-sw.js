#!/usr/bin/env node

'use strict';
const fs = require('fs'),
	path = require('path'),
	// 项目根目录
	ROOT_DIR = __dirname + '/..',
	// 扫描目录收集文件
	scanDirectory = (dir, basePath = '') => {
		const files = [],
			items = fs.readdirSync(dir);
		for (const item of items) {
			const fullPath = path.join(dir, item),
				relativePath = path.join(basePath, item).replace(/\\/g, '/');
			// 检测需要排除的目录和文件
			if (['.git', '.github', 'sw.js','data.7z' ,'vcsky/screenshots'].some(exclude => relativePath.includes(exclude)))
				continue;
			if (fs.statSync(fullPath).isDirectory()) {
				files.push(...scanDirectory(fullPath, relativePath));
			} else {
				// 检测允许的文件扩展名
				if (['.html', '.css', '.js', '.json', '.ico', '.jpg', '.png', '.mp4', '.wasm'].includes(
						path.extname(item).toLowerCase())) files.push('./' + relativePath);
			}
		}
		return files;
	};
// 主函数
try {
	console.log('🔍 扫描项目文件...');
	// 扫描并收集文件
	const files = scanDirectory(ROOT_DIR);
	// 添加根路径
	if (!files.includes('./')) files.unshift('./');
	// 排序文件（保持顺序一致性）
	files.sort((a, b) => a.localeCompare(b));
	console.log(`✅ 找到 ${files.length} 个文件需要缓存`);
	// 生成新的版本号（Unix 时间戳），并读取现有的 sw.js
	const newVersion = Math.floor(Date.now() / 1000).toString(),
		swPath = path.join(ROOT_DIR, 'sw.js');
	let swContent = fs.readFileSync(swPath, 'utf8');
	// 更新版本号
	console.log(`📦 新版本号: ${newVersion}`);
	swContent = swContent.replace(
		/const Ver = .*?,/,
		`const Ver = ${newVersion},`
	);
	// 更新资源列表 - 找到 addAll 数组并替换，匹配 addAll([...]) 部分
	const addAllRegex = /await \(\s*await\s+caches\.open\(cName \+ Ver\)\s*\)\.addAll\(\s*\[([\s\S]*?)\]\s*\);/;
	// 生成新的资源列表字符串
	if (swContent.match(addAllRegex)) swContent = swContent.replace(addAllRegex,
		`await (await caches.open(cName + Ver)).addAll([\n${files.map(file => `\t\t\t'${file}'`).join(',\n')}\n\t\t]);`
	);
	// 写回 sw.js
	fs.writeFileSync(swPath, swContent, 'utf8');
	console.log('✅ sw.js 已更新');
	// 设置输出供 GitHub Actions 使用
	const gethubOut = process.env.GITHUB_OUTPUT;
	if (gethubOut) {
		fs.appendFileSync(gethubOut, `version=${newVersion}\n`);
		fs.appendFileSync(gethubOut, `changed=true\n`);
	}
} catch (error) {
	console.error('❌ 更新失败:', error);
	process.exit(1);
}