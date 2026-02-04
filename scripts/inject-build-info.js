/**
 * 构建信息注入脚本
 * 从环境变量中读取构建平台和架构信息，然后将这些信息写入package.json
 *
 * 注意：CUDA 加速包已改为运行时动态下载，不再在构建时绑定特定版本
 */

const fs = require('fs');
const path = require('path');

// 获取package.json路径
const packageJsonPath = path.join(process.cwd(), 'package.json');

try {
  // 读取package.json
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // 从环境变量中获取构建信息
  const platform = process.env.BUILD_PLATFORM;
  const arch = process.env.BUILD_ARCH;

  // 创建buildInfo对象
  const buildInfo = {
    platform,
    arch,
    buildDate: new Date().toISOString(),
  };

  // 将buildInfo写入package.json
  packageJson.buildInfo = buildInfo;

  // 写入更新后的package.json
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

  console.log('Build info injected successfully:', buildInfo);
} catch (error) {
  console.error('Error injecting build info:', error);
  process.exit(1);
}
