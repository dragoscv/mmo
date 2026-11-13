Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAlias'

# Background gradient
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    [System.Drawing.ColorTranslator]::FromHtml('#7c3aed'),
    [System.Drawing.ColorTranslator]::FromHtml('#a855f7')
)

# Rounded rect
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 48
$d = $r * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$g.FillPath($brush, $path)

# White "M"
$font = New-Object System.Drawing.Font('Segoe UI', 120, [System.Drawing.FontStyle]::Bold)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = 'Center'
$sf.LineAlignment = 'Center'
$rect = New-Object System.Drawing.RectangleF(0, 8, $size, $size)
$g.DrawString('M', $font, $textBrush, $rect, $sf)

$g.Dispose()
$outPath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'assets') 'icon.png'
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "Created icon.png ($size x $size) at $outPath"
