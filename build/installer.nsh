; 安装包自定义脚本（electron-builder nsis.include），2026-11-17 r34a 最小修复：只换掉一个会崩溃的宏，其余保持 electron-builder 默认行为。
;
; 换掉「当前用户安装目录」宏（setInstallModePerUser），原因见 hub-peruser-install-mode.nsh。
; customHeader 在 multiUser.nsh 之后、.onInit 之前展开，此时原宏已定义、还没被用到。
!macro customHeader
  !macroundef setInstallModePerUser
  !include "hub-peruser-install-mode.nsh"
!macroend
