# Regenerate the Windows icon from the shared SVG; run with PowerShell on Windows.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
[xml]$svg = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../../packages/editor-ui/src/brand/forgon.svg') -Raw
$points = [System.Drawing.PointF[]]@($svg.svg.polygon.points.Split(' ') | ForEach-Object {
    $xy = $_.Split(',')
    [System.Drawing.PointF]::new([float]::Parse($xy[0], [cultureinfo]::InvariantCulture), [float]::Parse($xy[1], [cultureinfo]::InvariantCulture))
})
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stops = $svg.svg.defs.linearGradient.stop
    $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        [System.Drawing.PointF]::new(0, 0), [System.Drawing.PointF]::new(64, 64),
        [System.Drawing.ColorTranslator]::FromHtml($stops[0].'stop-color'),
        [System.Drawing.ColorTranslator]::FromHtml($stops[1].'stop-color'))
    $foreground = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($svg.svg.polygon.fill))
    $outline = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $png = [System.IO.MemoryStream]::new()
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.ScaleTransform($size / 64.0, $size / 64.0)
        $diameter = 2 * [int]$svg.svg.rect.rx
        $edge = 64 - $diameter
        $outline.AddArc(0, 0, $diameter, $diameter, 180, 90)
        $outline.AddArc($edge, 0, $diameter, $diameter, 270, 90)
        $outline.AddArc($edge, $edge, $diameter, $diameter, 0, 90)
        $outline.AddArc(0, $edge, $diameter, $diameter, 90, 90)
        $outline.CloseFigure()
        $graphics.FillPath($background, $outline)
        $graphics.FillPolygon($foreground, $points)
        $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Bmp)
        # ICO stores a DIB without the BMP file header, followed by a padded transparency mask.
        $dib = $png.ToArray()[14..($png.Length - 1)]
        [BitConverter]::GetBytes([int]($size * 2)).CopyTo($dib, 8)
        $mask = [byte[]]::new([int]([math]::Ceiling($size / 32.0) * 4 * $size))
        $frames += ,([byte[]]($dib + $mask))
    } finally {
        $png.Dispose(); $outline.Dispose(); $foreground.Dispose(); $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
}
$output = Join-Path $PSScriptRoot '../src-tauri/icons/icon.ico'
$stream = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dimension = [byte]($sizes[$i] % 256)
        $writer.Write($dimension); $writer.Write($dimension); $writer.Write([uint16]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
    $writer.Flush()
    # Decode each Windows icon size before replacing the shipped file.
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = $sizes[$i]
        # A single-frame file avoids GDI+'s multi-size selection limit at 256 px.
        $single = [System.IO.MemoryStream]::new()
        $singleWriter = [System.IO.BinaryWriter]::new($single)
        $singleWriter.Write([uint16]0); $singleWriter.Write([uint16]1); $singleWriter.Write([uint16]1)
        $singleWriter.Write([byte[]]($stream.ToArray()[(6 + 16 * $i)..(17 + 16 * $i)]))
        $singleWriter.Write([uint32]22); $singleWriter.Write([byte[]]$frames[$i]); $singleWriter.Flush()
        $single.Position = 0
        $check = [System.Drawing.Icon]::new($single)
        $decoded = $null
        try {
            $decoded = $check.ToBitmap()
            if ($decoded.Width -ne $size -or $decoded.Height -ne $size) { throw "Invalid brand icon frame: requested $size, decoded $($decoded.Width)x$($decoded.Height)." }
        } finally { if ($decoded) { $decoded.Dispose() }; $check.Dispose(); $singleWriter.Dispose(); $single.Dispose() }
    }
    [System.IO.File]::WriteAllBytes($output, $stream.ToArray())
} finally { $writer.Dispose(); $stream.Dispose() }
Write-Output "Updated Forgon Windows icon ($($sizes -join ', ') px)."
