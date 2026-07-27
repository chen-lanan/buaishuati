# 稳定签名

从 v2.0.5 起，本目录中的 `release.jks` 是“不爱刷题”的固定发布签名。
后续版本必须继续使用同一份签名，才能直接覆盖安装，不需要卸载旧版本。

`signing.properties` 已配置构建脚本和 Gradle 所需参数。请把完整源码 ZIP 当作敏感文件保存：
任何获得该 ZIP 的人都可能使用其中的签名材料制作可覆盖安装的 APK。

不要重新生成 `release.jks`，也不要随意修改 alias/password。
