import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { HeaderHeightContext } from "@react-navigation/elements";
import {
  createNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  NavigationIndependentTree,
  type NavigationState,
  type Theme as NavigationTheme,
  StackActions,
  useFocusEffect,
} from "@react-navigation/native";
import {
  createStackNavigator,
  type StackNavigationOptions,
  type StackScreenProps,
  TransitionPresets,
} from "@react-navigation/stack";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet } from "react-native";
import { fieldText, SheetFrame, useSheetBody, useTheme } from "@/ui";

/**
 * One bottom sheet per screen, opened from anywhere inside it (a card in a list row, a header button), with pages:
 * `open(content)` starts a sheet, `push(content)` goes to the next page in it (the conversation's options to its pins,
 * a member's options), `back()` returns, and `close()` puts it away. Pages are a stack navigator's screens inside the
 * sheet: they slide in from the side, a swipe from the edge or the bar's back goes back, and the sheet takes each
 * page's height. Keeps sheets out of list cells, where they would be clipped or recycled.
 */
export interface SheetHost {
  /** A new sheet, or the open one starting over with this page. `onClose`: once, when this sheet closes. */
  open: (content: ReactNode, options?: { onClose?: () => void }) => void;
  /**
   * The next page of the open sheet (a sheet of its own when none is open). Its title in the bar comes from its own
   * `SheetTitle`, or from `title`.
   */
  push: (content: ReactNode, options?: { title?: string }) => void;
  /** The page before; on the first one, the sheet closes. */
  back: () => void;
  /**
   * `then`, when a function: once the sheet is gone from the screen (before presenting the photo library, the camera,
   * a picker). Anything else is ignored, so `close` can be a button's or the scrim's press handler as it is.
   */
  close: (then?: unknown) => void;
  /**
   * Hears the sheet open (before it does anything, the keyboard leaving included) and close: the screen under it
   * keeps still meanwhile (a conversation freezes its list). Returns the unsubscribe.
   */
  subscribe: (listener: (open: boolean) => void) => () => void;
}

/** Where a page is: past the first, its title goes in the bar over it (`setTitle`) instead of its own top row. */
export interface SheetPage {
  pushed: boolean;
  setTitle: (title: string) => void;
}

interface Page {
  content: ReactNode;
  title?: string;
}

type PageParams = { page: { key: string } };
type PagesNavigation = ReturnType<typeof createNavigationContainerRef<PageParams>>;

const SheetContext = createContext<SheetHost | null>(null);
const PageContext = createContext<SheetPage | null>(null);
const PagesContext = createContext<{
  root: string;
  pages: RefObject<Map<string, Page>>;
  report: (key: string, height: number) => void;
} | null>(null);
const Stack = createStackNavigator<PageParams>();

export function SheetHostProvider({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<{ id: number; root: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState<string | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const pages = useRef(new Map<string, Page>());
  const nav = useMemo<PagesNavigation>(() => createNavigationContainerRef<PageParams>(), []);
  const seq = useRef(0);
  const isOpen = useRef(false);
  const onClosed = useRef<(() => void) | null>(null);
  const listeners = useRef(new Set<(open: boolean) => void>());
  // The height the sheet had, kept while a new first page measures (no collapse in between).
  const lastHeight = useRef<number | null>(null);
  // Whether a sheet is on screen (opening, open or still sliding out), and what waits for it to be gone.
  const shown = useRef(false);
  const afterGone = useRef<(() => void)[]>([]);
  const gone = useCallback(() => {
    shown.current = false;
    const waiting = afterGone.current;
    afterGone.current = [];
    for (const then of waiting) then();
  }, []);
  // `then` only when a function: the scrim's press passes its event here.
  const close = useCallback((then?: unknown) => {
    if (typeof then === "function") {
      if (shown.current) afterGone.current.push(then as () => void);
      else then();
    }
    isOpen.current = false;
    setOpen(false);
    for (const l of listeners.current) l(false);
    const closed = onClosed.current;
    onClosed.current = null;
    closed?.();
  }, []);
  const report = useCallback((key: string, height: number) => {
    setHeights((prev) => (prev[key] === height ? prev : { ...prev, [key]: height }));
  }, []);
  const host = useMemo<SheetHost>(() => {
    const start = (next: ReactNode, options?: { onClose?: () => void }) => {
      for (const l of listeners.current) l(true);
      const key = `page-${++seq.current}`;
      pages.current = new Map([[key, { content: next }]]);
      // A sheet coming in waits for its page's height; one already open keeps its own until then.
      if (!isOpen.current) lastHeight.current = null;
      setSheet({ id: seq.current, root: key });
      setTop(key);
      onClosed.current = options?.onClose ?? null;
      shown.current = true;
      isOpen.current = true;
      setOpen(true);
    };
    return {
      open: start,
      push: (next, options) => {
        if (!isOpen.current || !nav.isReady()) {
          start(next);
          return;
        }
        const key = `page-${++seq.current}`;
        pages.current.set(key, { content: next, ...(options?.title ? { title: options.title } : {}) });
        nav.dispatch(StackActions.push("page", { key }));
      },
      back: () => {
        if (nav.isReady() && nav.canGoBack()) nav.goBack();
        else close();
      },
      close,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    };
  }, [close, nav]);
  const known = top ? heights[top] : undefined;
  if (known !== undefined) lastHeight.current = known;
  const height = known ?? lastHeight.current;
  const pagesValue = useMemo(() => (sheet ? { root: sheet.root, pages, report } : null), [sheet, report]);
  return (
    <SheetContext.Provider value={host}>
      {children}
      <SheetFrame open={open} onClose={close} onGone={gone} onBack={host.back} height={height}>
        {sheet && pagesValue ? (
          <PagesContext.Provider value={pagesValue}>
            <Pages key={sheet.id} root={sheet.root} nav={nav} onTop={setTop} />
          </PagesContext.Provider>
        ) : null}
      </SheetFrame>
    </SheetContext.Provider>
  );
}

/**
 * The sheet's pages: a stack navigator of its own (apart from the app's), on the sheet's colors. The first page has no
 * bar (its own title leads it); the next ones get one with the back button and the page's title, and slide in as
 * the platform's pages do.
 */
function Pages({ root, nav, onTop }: { root: string; nav: PagesNavigation; onTop: (key: string) => void }) {
  const { colors, scheme } = useTheme();
  const ctx = useContext(PagesContext);
  const theme = useMemo<NavigationTheme>(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: colors.grouped,
        card: colors.grouped,
        text: colors.ink,
        primary: colors.ink,
        border: "transparent",
      },
    };
  }, [colors, scheme]);
  const screenOptions = useMemo<StackNavigationOptions>(
    () => ({
      ...TransitionPresets.SlideFromRightIOS,
      gestureEnabled: true,
      // The bar sits under the grabber, never under the status bar.
      headerStatusBarHeight: 0,
      headerStyle: { backgroundColor: colors.grouped },
      headerShadowVisible: false,
      headerTitleAlign: "center",
      headerTintColor: colors.ink,
      headerTitleStyle: fieldText("headline"),
      headerBackButtonDisplayMode: "minimal",
      cardStyle: { backgroundColor: colors.grouped },
    }),
    [colors],
  );
  const changed = useCallback(
    (state: NavigationState | undefined) => {
      const params = state?.routes[state.index]?.params as { key?: string } | undefined;
      if (params?.key) onTop(params.key);
    },
    [onTop],
  );
  return (
    <NavigationIndependentTree>
      <NavigationContainer ref={nav} theme={theme} onStateChange={changed}>
        {/* Pages stay plain views: the sheet is not one of the platform's screens. */}
        <Stack.Navigator detachInactiveScreens={false} screenOptions={screenOptions}>
          <Stack.Screen
            name="page"
            component={PageScreen}
            initialParams={{ key: root }}
            options={({ route }) => ({
              headerShown: route.params.key !== root,
              title: ctx?.pages.current.get(route.params.key)?.title ?? "",
            })}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}

/** One page: its content scrolling (the sheet drags from its top edge), measured so the sheet takes its height. */
function PageScreen({ route, navigation }: StackScreenProps<PageParams, "page">) {
  const ctx = useContext(PagesContext);
  const body = useSheetBody();
  const key = route.params.key;
  const pushed = key !== ctx?.root;
  const bar = useContext(HeaderHeightContext);
  const headerHeight = pushed ? (bar ?? 0) : 0;
  const contentHeight = useRef(0);
  const report = ctx?.report;
  // The bar measured after the content: the page's height counts it too.
  useEffect(() => {
    if (contentHeight.current > 0) report?.(key, Math.ceil(contentHeight.current + headerHeight));
  }, [headerHeight, key, report]);
  const page = useMemo<SheetPage>(
    () => ({ pushed, setTitle: (title) => navigation.setOptions({ title }) }),
    [pushed, navigation],
  );
  return (
    <PageContext.Provider value={page}>
      <BottomSheetScrollView
        // The page in sight is the one the sheet scrolls with.
        focusHook={useFocusEffect}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[body, styles.in]}
        onContentSizeChange={(_w, h) => {
          contentHeight.current = h;
          report?.(key, Math.ceil(h + headerHeight));
        }}
      >
        {ctx?.pages.current.get(key)?.content ?? null}
      </BottomSheetScrollView>
    </PageContext.Provider>
  );
}

export function useSheet(): SheetHost {
  const host = useContext(SheetContext);
  if (!host) throw new Error("useSheet must be used inside SheetHostProvider");
  return host;
}

/** The screen's sheet host, or null on a screen without one (a text shown outside a conversation). */
export function useSheetIfAny(): SheetHost | null {
  return useContext(SheetContext);
}

/** The page this content is on, or null outside a sheet's pages. */
export function useSheetPage(): SheetPage | null {
  return useContext(PageContext);
}

const styles = StyleSheet.create({
  in: { gap: 12 },
});
