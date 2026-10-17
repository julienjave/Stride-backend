$root = 'D:\Projects\Stride\Stride-backend'
$output = Join-Path $root 'backend-codebase-snapshot.md'

# Collect files
$files = [System.Collections.Generic.List[string]]::new()

# All files under src, scripts, test
foreach ($dir in @('src', 'scripts', 'test')) {
    $path = Join-Path $root $dir
    if (Test-Path $path) {
        Get-ChildItem -Path $path -Recurse -File -Force | ForEach-Object { $files.Add($_.FullName) }
    }
}

# Specific root files
$specific = @(
    'docker-compose.yml',
    'drizzle.config.ts',
    '.env.example',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'nest-cli.json',
    'eslint.config.mjs'
)
foreach ($f in $specific) {
    $fp = Join-Path $root $f
    if (Test-Path $fp -PathType Leaf) { $files.Add($fp) }
}

# Sort and unique
$files = $files | Sort-Object -Unique

function Get-Language($ext) {
    switch ($ext.ToLower()) {
        '.ts' { return 'typescript' }
        '.tsx' { return 'typescript' }
        '.js' { return 'javascript' }
        '.mjs' { return 'javascript' }
        '.cjs' { return 'javascript' }
        '.json' { return 'json' }
        '.yml' { return 'yaml' }
        '.yaml' { return 'yaml' }
        '.sql' { return 'sql' }
        '.sh' { return 'bash' }
        '.html' { return 'html' }
        '.css' { return 'css' }
        '.md' { return 'markdown' }
        default { return '' }
    }
}

$sb = [System.Text.StringBuilder]::new()

foreach ($file in $files) {
    $rel = $file.Substring($root.Length + 1).Replace('\', '/')
    $ext = [IO.Path]::GetExtension($file)
    $lang = Get-Language $ext
    
    [void]$sb.AppendLine("## $rel")
    [void]$sb.AppendLine()
    
    if ($lang) {
        $fence = '```' + $lang
    } else {
        $fence = '```'
    }
    [void]$sb.AppendLine($fence)
    
    $content = [IO.File]::ReadAllText($file)
    [void]$sb.Append($content)
    
    # Ensure exactly one newline before closing fence
    if (-not ($content.EndsWith("`n") -or $content.EndsWith("`r`n"))) {
        [void]$sb.AppendLine()
    }
    
    [void]$sb.AppendLine('```')
}

[IO.File]::WriteAllText($output, $sb.ToString())

$fileCount = $files.Count
$outputInfo = Get-Item $output
Write-Host ('Files included: ' + $fileCount)
Write-Host ('Output file size: ' + $outputInfo.Length + ' bytes')
