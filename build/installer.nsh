; NSIS custom install script for VoiceMessenger
; Открываем порты сразу при установке — чтобы позже не всплывало
; окно брандмауэра Windows при первом запуске приложения.
; Установщик запрашивает права администратора (perMachine: true),
; поэтому netsh выполняется успешно.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall add rule name="VoiceMessenger 3001 TCP" dir=in action=allow protocol=TCP localport=3001'
  nsExec::Exec 'netsh advfirewall firewall add rule name="VoiceMessenger 3001 UDP" dir=in action=allow protocol=UDP localport=3001'
  nsExec::Exec 'netsh advfirewall firewall add rule name="VoiceMessenger 3002 UDP" dir=in action=allow protocol=UDP localport=3002'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="VoiceMessenger 3001 TCP"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="VoiceMessenger 3001 UDP"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="VoiceMessenger 3002 UDP"'
!macroend
