import { execSync } from 'child_process';
import { logMessage } from './storeManager';

/**
 * 检查系统是否支持CUDA并返回支持的版本
 */
export function checkCudaSupport() {
  if (process.platform !== 'win32') return false;

  try {
    // 检查nvcc是否存在（CUDA Toolkit的编译器）
    execSync('nvcc --version', { encoding: 'utf8' });

    // 检查nvidia-smi是否存在（NVIDIA驱动程序）
    const nsmiResult = execSync('nvidia-smi', { encoding: 'utf8' });
    logMessage(`nsmiResult: ${nsmiResult}`, 'info');

    // 从nvidia-smi输出中提取CUDA版本
    const cudaVersionMatch = nsmiResult.match(/CUDA Version: (\d+\.\d+)/);
    logMessage(
      `cudaVersionMatch: ${JSON.stringify(cudaVersionMatch, null, 2)}`,
      'info',
    );

    if (cudaVersionMatch) {
      const cudaVersion = parseFloat(cudaVersionMatch[1]);
      logMessage(`cudaVersion: ${cudaVersion}`, 'info');
      // 根据CUDA版本选择合适的addon
      if (cudaVersion >= 12.0) {
        return '12.4.1';
      } else if (cudaVersion >= 11.8) {
        return '11.8.0';
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}
