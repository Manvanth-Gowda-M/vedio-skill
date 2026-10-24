# CreatorFlow Windows SAPI bridge. Input: a UTF-8 JSON job file ($JobFile, prepended by
# the adapter). Output: one line "CF_RESULT <json>" on stdout. Uses only System.Speech
# (part of .NET Framework on Windows); no network, no installation. Run with
# -EncodedCommand, so no script file and no execution-policy change is involved.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit($o) { [Console]::Out.WriteLine("CF_RESULT " + ($o | ConvertTo-Json -Compress -Depth 6)) }
try {
  Add-Type -AssemblyName System.Speech
  $job = [System.IO.File]::ReadAllText($JobFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    if ($job.mode -eq 'list') {
      $voices = @()
      foreach ($v in $s.GetInstalledVoices()) {
        $i = $v.VoiceInfo
        $ver = $null
        if ($i.AdditionalInfo.ContainsKey('Version')) { $ver = [string]$i.AdditionalInfo['Version'] }
        $voices += [pscustomobject]@{ id = [string]$i.Id; name = [string]$i.Name; culture = [string]$i.Culture.Name; gender = [string]$i.Gender; enabled = [bool]$v.Enabled; version = $ver }
      }
      Emit ([pscustomobject]@{ ok = $true; voices = $voices; os = [Environment]::OSVersion.Version.ToString(); speech = [System.Speech.Synthesis.SpeechSynthesizer].Assembly.GetName().Version.ToString() })
    } else {
      $s.SelectVoice([string]$job.voice)
      $s.Rate = [int]$job.rate
      $s.Volume = 100
      $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo([int]$job.sampleRate, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
      $n = 0
      foreach ($it in $job.items) {
        $s.SetOutputToWaveFile([string]$it.out, $fmt)
        $s.Speak([string]$it.text)
        $s.SetOutputToNull()
        $n++
      }
      Emit ([pscustomobject]@{ ok = $true; count = $n; voice = $s.Voice.Name })
    }
  } finally { $s.Dispose() }
} catch {
  Emit ([pscustomobject]@{ ok = $false; error = $_.Exception.Message })
  exit 3
}
