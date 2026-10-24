# 发行包 · 信息管家

本目录存放 **信息管家** 的 Windows x64 可运行包体（由桌面快捷方式实际指向的安装/发布目录整理而来）。

| 项目 | 内容 |
| --- | --- |
| 版本 | `1.0.0` |
| 平台 | Windows x64 |
| 包体路径 | `release/1.0.0/info-butler-1.0.0-win-x64/` |
| 文件数 | 23 |
| 体积 | 约 83.6 MB |

## 运行方式

双击 `信息管家.exe`

## 校验完整性

```bash
cd release
sha256sum -c SHA256SUMS.txt
```

Windows PowerShell：

```powershell
Get-Content release\SHA256SUMS.txt | ForEach-Object {
  $h, $p = $_ -split '  ', 2
  if ((Get-FileHash $p -Algorithm SHA256).Hash -ne $h.ToUpper()) { "MISMATCH $p" }
}
```

## 关于 信息管家

个人信息管家 Agent：记录、自动分类、检索、问答与阶段总结（单文件版）。

## 未纳入的内容

无（目录内即为完整发行包）。

以上目录属于开发环境、运行期缓存或大体积模型权重，不影响程序本体运行。
