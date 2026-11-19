import ExpoModulesCore
import UIKit

/// A pushed screen's subtitle in the system's own bar: iOS 26's `UINavigationItem.subtitle`, under the title and
/// centred with it by the bar itself, beside whatever buttons the bar holds. The navigator the app uses sets the
/// title and the buttons but has no subtitle, so a view of no size, placed in the screen, sets it on the item of the
/// first controller up its responder chain: the screen's own. Before iOS 26 the app draws the title and its line
/// itself (`PushedHeader`).
public class NavSubtitleModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NavSubtitle")

    Function("supported") { () -> Bool in
      barHasSubtitle()
    }

    View(NavSubtitleView.self) {
      Prop("subtitle") { (view: NavSubtitleView, subtitle: String?) in
        view.subtitle = subtitle
      }
    }
  }
}

/// iOS 26 and later, built by a compiler that knows it: the system's bar has a subtitle of its own.
private func barHasSubtitle() -> Bool {
  #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      return true
    }
  #endif
  return false
}

final class NavSubtitleView: ExpoView {
  var subtitle: String? {
    didSet { apply() }
  }

  // Set again as it joins the screen: its props come before it has a place to find the screen from.
  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    apply()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    apply()
  }

  private func apply() {
    #if compiler(>=6.2)
      if #available(iOS 26.0, *) {
        screenController()?.navigationItem.subtitle = subtitle
      }
    #endif
  }

  /// The screen's controller: the first one up the responder chain (a screen's view answers to its controller).
  private func screenController() -> UIViewController? {
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController {
        return controller
      }
      responder = current.next
    }
    return nil
  }
}
