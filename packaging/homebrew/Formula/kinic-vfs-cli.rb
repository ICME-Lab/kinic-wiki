class KinicVfsCli < Formula
  desc "Operator CLI for Kinic VFS-backed wiki databases and Skill Registry packages"
  homepage "https://github.com/ICME-Lab/kinic-wiki"
  version "0.1.2"

  if OS.mac? && Hardware::CPU.arm?
    url "https://github.com/ICME-Lab/kinic-wiki/releases/download/v#{version}/kinic-vfs-cli-v#{version}-macos-arm64.tar.gz"
    sha256 "5eb784fc319a38ec479e3f1c134e0826900bc07cea962f18cb808b420e08e651"
  else
    odie "kinic-vfs-cli v#{version} formula currently supports macOS arm64 only"
  end

  def install
    bin.install "kinic-vfs-cli"
  end

  test do
    assert_match "Usage:", shell_output("#{bin}/kinic-vfs-cli --help")
  end
end
