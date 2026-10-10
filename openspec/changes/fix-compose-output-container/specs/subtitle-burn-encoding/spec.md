## ADDED Requirements

### Requirement: 硬烧只重编码真正的视频流

硬字幕烧录（`keep`/`replace`/`addTrack`）SHALL 只映射源文件里真正的视频流（`-map 0:V`），MUST NOT 把内嵌封面图（`attached pic`，如 yt-dlp `--embed-thumbnail`、YoutubeDownloader 写入的 `Video: mjpeg … (attached pic)`）送进字幕滤镜与 libx264。软封装与无字幕是流拷贝，保持 `-map 0:v`，封面原样保留；`hard+mix` 经 filter_complex 的 `[0:v]` 标签只取第一路视频流，不受影响。

#### Scenario: 带封面的 MP4 硬烧

- **WHEN** 对带一路 mjpeg 封面的 MP4 硬烧字幕（保留原声、替换音轨或叠加配音轨）
- **THEN** 命令只映射真正的视频流，成品只有一路 H.264 视频、不含封面，作业成功，不出现 `Could not find tag for codec h264`

#### Scenario: 软封装保留封面

- **WHEN** 对同一文件软封装字幕（流拷贝）
- **THEN** 封面作为附加图片原样保留，命令仍映射 `0:v`

### Requirement: 硬烧输出宽高为偶数

硬字幕烧录 SHALL 在字幕滤镜之后把画面宽高向下取偶（`crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0`：丢掉右/下多出的 1 像素；MUST NOT 缩放或加黑边；本来就是偶数时是空操作），使 libx264 不会因奇数宽或高而失败。字幕 MUST 仍按原始画面渲染，位置不变。软封装与无字幕是流拷贝，MUST NOT 加入该滤镜。

#### Scenario: 奇数宽度源硬烧成功

- **WHEN** 对 853x480 的 yuv420p 源用 libx264 硬烧字幕
- **THEN** 作业成功，成品为 852x480 的 H.264，不再出现 `width not divisible by 2`

#### Scenario: 偶数分辨率源保持不变

- **WHEN** 对 640x360 的源硬烧字幕
- **THEN** 成品仍是 640x360

## MODIFIED Requirements

### Requirement: 8-bit pixel format for hardware encoding path

硬件编码路径 SHALL 在字幕滤镜与偶数宽高裁剪之后追加 `format=nv12`，将 10-bit/4:2:2 等源统一转换为硬件编码器可接受的 8-bit 4:2:0 输入。libx264 路径 MUST NOT 追加该转换（保持现状对高位深源的行为）。

#### Scenario: 10-bit 源硬件烧录不报错

- **WHEN** 用户对 10-bit HEVC 源视频以硬件加速执行烧录
- **THEN** 滤镜链为 `<字幕滤镜>,<偶数宽高裁剪>,format=nv12`，编码正常完成

#### Scenario: CPU 路径无像素格式转换

- **WHEN** 用户以 CPU 编码方式执行烧录
- **THEN** 滤镜链为 `<字幕滤镜>,<偶数宽高裁剪>`，无 `format=nv12`
