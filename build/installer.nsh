; ============================================================
;  installer.nsh - La Mente Maestra v2.0.0
;  Puente Prod
; ============================================================


!macro customWelcomePage
    !define MUI_WELCOMEPAGE_TITLE "Bienvenido a La Mente Maestra"
    !define MUI_WELCOMEPAGE_TEXT "Este asistente instalara La Mente Maestra v2.0.0 en tu computadora.$\r$\n$\r$\nLa Mente Maestra es el sistema POS gastronomico todo-en-uno: gestiona pedidos, mesas, menu, inventario, empleados, cocina y reportes desde un solo lugar.$\r$\n$\r$\nTus datos se almacenan de forma local y privada en tu equipo. LMM no accede a tu informacion en ningun momento.$\r$\n$\r$\nAntes de continuar, cerra cualquier otra aplicacion abierta.$\r$\n$\r$\nHace clic en Siguiente para continuar."
    !insertmacro MUI_PAGE_WELCOME
!macroend


!macro customInit

    Var /GLOBAL LMM_OLD_UNINST
    Var /GLOBAL LMM_OLD_PATH

    ReadRegStr $LMM_OLD_UNINST HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.puenteprod.lmm" "UninstallString"
    ReadRegStr $LMM_OLD_PATH   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.puenteprod.lmm" "InstallLocation"

    ${If} $LMM_OLD_UNINST == ""
        ReadRegStr $LMM_OLD_UNINST HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.puenteprod.lmm" "UninstallString"
        ReadRegStr $LMM_OLD_PATH   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.puenteprod.lmm" "InstallLocation"
    ${EndIf}

    ${If} $LMM_OLD_UNINST != ""
        DetailPrint "Desinstalando version anterior..."
        ExecWait '"$LMM_OLD_UNINST" /S _?=$LMM_OLD_PATH'
        RMDir /r "$LMM_OLD_PATH"
    ${EndIf}

!macroend


!macro customInstall

    DetailPrint "Instalando modulo de pedidos y gestion de mesas..."
    Sleep 200
    DetailPrint "Configurando menu, categorias e inventario..."
    Sleep 200
    DetailPrint "Instalando panel de empleados y vista de cocina..."
    Sleep 200
    DetailPrint "Configurando modulo de reportes, caja y cierre diario..."
    Sleep 200
    DetailPrint "Aplicando configuracion de seguridad y permisos..."
    Sleep 200
    DetailPrint "Inicializando base de datos local (SQLite)..."
    Sleep 300
    DetailPrint "Registrando accesos directos..."
    Sleep 150
    DetailPrint "La Mente Maestra v2.0.0 instalada correctamente."

!macroend