!macro customInstall
  ; Register before the first app launch so invite links work immediately after installation.
  WriteRegStr HKCU "Software\Classes\bwe-e-ep" "" "URL:Bweeep Invite Link"
  WriteRegStr HKCU "Software\Classes\bwe-e-ep" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\bwe-e-ep\DefaultIcon" "" "$INSTDIR\Bweeep.exe,0"
  WriteRegStr HKCU "Software\Classes\bwe-e-ep\shell\open\command" "" '"$INSTDIR\Bweeep.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\bwe-e-ep"
!macroend
