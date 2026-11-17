; 「只为当前用户安装」的安装目录（替换 electron-builder 26.8.1 multiUser.nsh 里的同名宏，由 installer.nsh 的 customHeader 引入）。
;
; 原版在本机还没有「当前用户」安装记录时，用 System 插件调 SHGetKnownFolderPath，再按 NSIS_MAX_STRLEN 个宽字符整段读回返回的路径。
; 返回的缓冲区只有路径那么长，多读的部分越过缓冲区。2026-11-17 在一台装有终端安全软件的办公电脑上实测：静默安装且按「当前用户」安装时
; 这一步每次都访问冲突（System.dll 0xc0000005，偏移 0x1581），安装包 4 秒内崩掉、一个文件都没装（8 次 8 次）；换掉这段后同样参数 2 次 2 次装好。
; 新版 Hub 换完整安装包时正是这样静默安装的，表现为「下载成功、重启没反应」。
; 原版读到的值随后被 System::Store L 还原掉，最终用的始终是 $LocalAppData\Programs，所以这里直接用它，行为不变、不再调用那段读取。
!macro setInstallModePerUser
  StrCpy $installMode CurrentUser
  SetShellVarContext current

  # сhecks registry for previous installation path
  ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $perUserInstallationFolder != ""
    StrCpy $INSTDIR $perUserInstallationFolder
  ${else}
    StrCpy $INSTDIR "$LocalAppData\Programs\${APP_FILENAME}"
  ${endif}

  # allow /D switch to override installation path https://github.com/electron-userland/electron-builder/issues/1551
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${endif}
!macroend
