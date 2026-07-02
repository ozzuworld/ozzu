// iPhone 14/15 logical layout (points). Safe-area insets: 59 top (Dynamic
// Island / notch era), 34 bottom (home indicator).
export function usePhoneLayout() {
  return {
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
    isPhone: true,
    screenWidth: 393,
    screenHeight: 852,
  };
}

export default usePhoneLayout;
