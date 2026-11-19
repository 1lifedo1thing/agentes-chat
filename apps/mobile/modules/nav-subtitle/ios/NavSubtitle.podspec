# A pushed screen's subtitle in the system's own bar (iOS 26): a local Expo module, linked by `expo prebuild` from
# apps/mobile/modules.
Pod::Spec.new do |s|
  s.name           = 'NavSubtitle'
  s.version        = '1.0.0'
  s.summary        = "A pushed screen's subtitle in the system's own navigation bar."
  s.description    = s.summary
  s.license        = 'AGPL-3.0-only'
  s.author         = 'agentes.chat'
  s.homepage       = 'https://agentes.chat'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/agentes-chat/agentes-chat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
