/**
 * 构建信息注入脚本
 * 从环境变量中读取构建平台、架构和CUDA版本信息，然后将这些信息写入package.json
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
  const cudaVersion = process.env.CUDA_VERSION;
  const cudaOpt = process.env.CUDA_OPT;
  
  // 创建buildInfo对象
  const buildInfo = {
    platform,
    arch,
    buildDate: new Date().toISOString()
  };
  
  // 如果是Windows平台且有CUDA版本信息，则添加CUDA相关信息
  if (platform === 'win32' && cudaVersion) {
    buildInfo.cudaVersion = cudaVersion;
    if (cudaOpt) {
      buildInfo.cudaOpt = cudaOpt;
    }
  }
  
  // 将buildInfo写入package.json
  packageJson.buildInfo = buildInfo;
  
  // 写入更新后的package.json
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
  
  console.log('Build info injected successfully:', buildInfo);
} catch (error) {
  console.error('Error injecting build info:', error);
  process.exit(1);
}