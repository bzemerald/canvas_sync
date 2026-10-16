// Whether this process may post input events (System Settings > Privacy > Accessibility).
import ApplicationServices
print(AXIsProcessTrusted() ? "trusted" : "not trusted")
