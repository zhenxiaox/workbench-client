# Offline OCR for the workbench, using the OCR engine built into Windows 10/11
# (Windows.Media.Ocr). No network, no API key, no third-party binary.
#
# Usage (called by wb-server.js):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass \
#     -File wb-ocr.ps1 -Image <input.png> -OutFile <output.txt> [-Scale 2]
#
# Notes for future maintainers:
#  * PowerShell 5.1 needs System.Runtime.WindowsRuntime loaded before AsTask()
#    can be used as an awaiter for WinRT IAsyncOperation<T>.
#  * Upscaling the image first helps a lot: Windows OCR loses small UI text.
#    Measured on a 1440x900 app screenshot: 1x missed words like
#    "客服会话 / 买家评价 / 效率工具", 2x picked them up.
#  * Windows OCR inserts spaces between CJK characters; we strip those so the
#    output looks like normal Chinese text.
#  * Keep this file ASCII-only: it is shipped next to the app and cmd/PowerShell
#    encoding of non-ASCII script files is not worth the trouble.

param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [double]$Scale = 0
)

$ErrorActionPreference = 'Stop'
$sb = New-Object System.Text.StringBuilder

function Await($op, $type) {
  $t = $script:asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

try {
  if (-not (Test-Path -LiteralPath $Image)) { throw "input not found: $Image" }

  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Drawing

  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  if (-not $script:asTaskGeneric) { throw 'AsTask(IAsyncOperation<T>) not found' }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw 'no OCR engine available for the current user profile languages' }

  # --- upscale before OCR ---
  # Windows OCR is weak on small text, so we scale up first.
  # $Scale = 0 means "decide from the image size": make the short side at least
  # MIN_SHORT px, capped at MAX_SCALE. Measured on a 442x558 downscaled screenshot:
  #   2x -> "https：//m． 1 8 ℃ om / 0 什 er. / 815220550798"
  #   4x -> "https://m.l 8 ℃ om / 0 什 er, / 815220550798"
  #   6x -> "https://detail.1688 ℃ om / 0 什 e ..."   (1688 finally read correctly)
  # Bigger is better until the source runs out of real pixels, so we also cap at 8000px.
  $work = $Image
  $tmpUp = $null
  $effScale = $Scale
  if ($effScale -le 0) {
    $probe = [System.Drawing.Image]::FromFile($Image)
    try {
      $short = [Math]::Min($probe.Width, $probe.Height)
      if ($short -lt 1) { $short = 1 }
      $effScale = [Math]::Min(5.0, [Math]::Max(1.0, [Math]::Ceiling(1600.0 / $short)))
    }
    finally { $probe.Dispose() }
  }
  if ($effScale -gt 1.01) {
    $src = [System.Drawing.Image]::FromFile($Image)
    try {
      $w = [int]($src.Width * $effScale)
      $h = [int]($src.Height * $effScale)
      # guard against absurd sizes (Windows OCR is slow / fails on huge bitmaps)
      if ($w -le 8000 -and $h -le 8000) {
        $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($src, 0, 0, $w, $h)
        $g.Dispose()
        $tmpUp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'wb-ocr-up-' + [System.Guid]::NewGuid().ToString('N') + '.png')
        $bmp.Save($tmpUp, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $work = $tmpUp
      }
    }
    finally { $src.Dispose() }
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($work)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose()

  $text = ($result.Text -replace "`r?`n", "`n")
  # strip the spaces Windows OCR inserts between CJK characters
  $text = [regex]::Replace($text, '(?<=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])[ \t]+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])', '')
  # collapse runs of blank lines
  $text = [regex]::Replace($text, '\n{3,}', "`n`n")

  if ($tmpUp) { Remove-Item -LiteralPath $tmpUp -Force -ErrorAction SilentlyContinue }

  [System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding($false)))
  exit 0
}
catch {
  $msg = 'OCR_ERROR: ' + $_.Exception.Message
  try { [System.IO.File]::WriteAllText($OutFile, $msg, (New-Object System.Text.UTF8Encoding($false))) } catch {}
  Write-Error $msg
  exit 1
}
