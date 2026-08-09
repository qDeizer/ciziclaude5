using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

internal static class CiziClaudeRuntimeHost
{
    private const string DefaultAumid = "Claude_pzs8sxrjxfjjc!Claude";
    private const string EnvironmentKeyPath = "Environment";
    private const string DeveloperToolsVariable = "CLAUDE_DEV_TOOLS";
    private const int SwRestore = 9;
    private const uint WmClose = 0x0010;
    private const uint InputKeyboard = 1;
    private const uint KeyeventfKeyup = 0x0002;
    private const ushort VkControl = 0x11;
    private const ushort VkShift = 0x10;
    private const ushort VkJ = 0x4A;
    private const ushort VkReturn = 0x0D;

    private const string OnboardingActionGatewaySelected = "gateway-selected";
    private const string OnboardingActionNotPresent = "not-present";

    // This code is intentionally independent of Claude's bundles, element
    // classes and React component tree. It runs in the inspected renderer and
    // follows text nodes added by later SPA route changes.
    private const string BrandingScript =
        "(()=>{if(globalThis.__ciziCodeGatewayBranding)return;globalThis.__ciziCodeGatewayBranding=true;" +
        "const e=/\\bGateway\\b/gi,n=o=>{const t=o&&o.nodeValue;if(!t||!e.test(t)){e.lastIndex=0;return}" +
        "e.lastIndex=0;o.nodeValue=t.replace(e,'Cizi Code');e.lastIndex=0},r=o=>{if(!o)return;" +
        "if(o.nodeType===Node.TEXT_NODE){n(o);return}const t=document.createTreeWalker(o,NodeFilter.SHOW_TEXT);" +
        "let i;while(i=t.nextNode())n(i)},s=()=>{const o=document.documentElement;if(!o)return;" +
        "r(o);new MutationObserver(t=>{for(const i of t){if(i.type==='characterData'){n(i.target);continue}" +
        "for(const a of i.addedNodes)r(a)}}).observe(o,{childList:true,subtree:true,characterData:true})};" +
        "document.documentElement?s():document.addEventListener('DOMContentLoaded',s,{once:true})})();";

    private sealed class WindowCandidate
    {
        internal IntPtr Handle;
        internal string Title;
        internal int Width;
        internal int Height;
    }

    private sealed class EnvironmentSnapshot
    {
        internal bool Existed;
        internal object Value;
        internal RegistryValueKind Kind;
    }

    // First-run welcome/onboarding automation evidence. Selectors are never
    // tied to a single localized string: AutomationIds take priority and
    // English/Turkish name lists are matched by token so the Gateway option
    // can be verified before any generic Continue/Devam control is touched.
    private sealed class WelcomeScreenAutomation
    {
        internal static readonly string[] GatewayAutomationIds = new[]
        {
            "gateway", "gateway-option", "gateway-option-radio", "gateway-card",
            "welcome-gateway", "login-gateway", "signin-gateway", "sign-in-gateway",
            "continue-with-gateway", "gateway-continue"
        };

        internal static readonly string[] GatewayNameTokens = new[]
        {
            "gateway", "ağ geçidi", "ag geçidi", "ağ geçidiyle", "ag geçidiyle"
        };

        internal static readonly string[] ContinueNameTokens = new[]
        {
            "continue", "devam", "devam et", "get started", "başla", "başlat",
            "log in", "giriş yap", "sign in", "claude'a giriş yap", "claude a giriş yap",
            "login"
        };

        // Real main-workspace/composer markers, EN + TR. Nothing here matches
        // the first-run welcome/login screen, so an unknown state fails closed
        // instead of opening DevTools into the onboarding UI.
        internal static readonly string[] WorkspaceMarkers = new[]
        {
            "new chat", "yeni sohbet",
            "composer",
            "message claude", "claude'a mesaj yaz", "claude a mesaj yaz",
            "ask anything", "what can i help", "nasıl yardımcı olabilirim",
            "size nasıl yardımcı"
        };
    }

    // Controls whose Name carries useful semantic content for the welcome
    // and workspace detectors. Restricting the traversal keeps each poll
    // bounded and avoids treating decorative panes as clickable evidence.
    private static readonly Condition NameRelevantCondition = new OrCondition(
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.RadioButton),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Hyperlink),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        internal uint Type;
        internal InputUnion Union;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        internal KeyboardInput Keyboard;

        // INPUT is a tagged union. The mouse member keeps the native union at
        // its required x64 size even though this host emits keyboard input.
        [FieldOffset(0)]
        internal MouseInput Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        internal int X;
        internal int Y;
        internal uint MouseData;
        internal uint Flags;
        internal uint Time;
        internal UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        internal ushort VirtualKey;
        internal ushort ScanCode;
        internal uint Flags;
        internal uint Time;
        internal UIntPtr ExtraInfo;
    }

    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);
    }

    private delegate bool EnumWindowsDelegate(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsDelegate callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool SetFocus(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private static int Main(string[] args)
    {
        string aumid = Argument(args, "--aumid") ?? DefaultAumid;
        int timeoutMilliseconds = IntegerArgument(args, "--timeout-ms", 60000, 5000, 120000);
        EnvironmentSnapshot snapshot = null;
        uint processId = 0;
        IntPtr mainWindow = IntPtr.Zero;
        IntPtr developerToolsWindow = IntPtr.Zero;
        bool environmentRestored = false;
        bool onboardingDetected = false;
        string onboardingAction = OnboardingActionNotPresent;
        bool mainWorkspaceVerified = false;
        bool injected = false;
        bool executionVerified = false;
        bool visibleBrandingVerified = false;
        bool verified = false;
        bool developerToolsClosed = false;

        try
        {
            snapshot = CaptureDeveloperToolsEnvironment();
            SetDeveloperToolsEnvironment("detach");
            try
            {
                processId = Activate(aumid);
            }
            finally
            {
                RestoreDeveloperToolsEnvironment(snapshot);
                environmentRestored = true;
            }

            Stopwatch timer = Stopwatch.StartNew();
            WaitForMainWindow(processId, timeoutMilliseconds, out mainWindow);
            if (mainWindow == IntPtr.Zero)
                throw new InvalidOperationException("CLAUDE_MAIN_WINDOW_NOT_FOUND");

            // Welcome/onboarding gate: inspect the main window with UIA and let
            // the first-run state settle BEFORE any DevTools work begins.
            ResolveWelcomeState(mainWindow, timer, timeoutMilliseconds,
                out onboardingDetected, out onboardingAction);

            // Workspace gate: never open DevTools or inject branding until a
            // real main workspace/composer marker is visible.
            mainWorkspaceVerified = WaitForMainWorkspace(mainWindow, timer, timeoutMilliseconds);
            if (!mainWorkspaceVerified)
                throw new InvalidOperationException("CLAUDE_MAIN_WORKSPACE_NOT_FOUND");

            developerToolsWindow = WaitForDeveloperToolsWindow(processId, timer, timeoutMilliseconds);
            if (developerToolsWindow == IntPtr.Zero)
                throw new InvalidOperationException("CLAUDE_DEVTOOLS_WINDOW_NOT_FOUND");

            FocusWindow(developerToolsWindow);
            AutomationElement consolePrompt = FocusConsolePrompt(developerToolsWindow);
            SetConsoleScript(consolePrompt, BrandingScript);
            SendKey(VkReturn);
            injected = true;
            visibleBrandingVerified = WaitForVisibleBranding(mainWindow, 15000);
            executionVerified = visibleBrandingVerified;
            verified = visibleBrandingVerified;
            if (!verified)
                throw new InvalidOperationException("CLAUDE_RUNTIME_INJECTION_UNVERIFIED");

            developerToolsClosed = PostMessage(developerToolsWindow, WmClose, IntPtr.Zero, IntPtr.Zero);
            Console.Out.WriteLine(
                "{\"ok\":true,\"processId\":" + processId +
                ",\"mainWindow\":" + mainWindow.ToInt64() +
                ",\"developerToolsWindow\":" + developerToolsWindow.ToInt64() +
                ",\"onboardingDetected\":" + JsonBoolean(onboardingDetected) +
                ",\"onboardingAction\":\"" + JsonEscape(onboardingAction) + "\"" +
                ",\"mainWorkspaceVerified\":" + JsonBoolean(mainWorkspaceVerified) +
                ",\"injected\":" + JsonBoolean(injected) +
                ",\"executionVerified\":" + JsonBoolean(executionVerified) +
                ",\"visibleBrandingVerified\":" + JsonBoolean(visibleBrandingVerified) +
                ",\"verified\":" + JsonBoolean(verified) +
                ",\"developerToolsClosed\":" + JsonBoolean(developerToolsClosed) +
                ",\"environmentRestored\":" + JsonBoolean(environmentRestored) + "}");
            return 0;
        }
        catch (Exception error)
        {
            if (!environmentRestored && snapshot != null)
            {
                try
                {
                    RestoreDeveloperToolsEnvironment(snapshot);
                    environmentRestored = true;
                }
                catch { }
            }
            if (developerToolsWindow != IntPtr.Zero && IsWindow(developerToolsWindow))
            {
                try { PostMessage(developerToolsWindow, WmClose, IntPtr.Zero, IntPtr.Zero); } catch { }
            }
            Console.Error.WriteLine(
                "{\"ok\":false,\"code\":\"" + JsonEscape(error.Message) +
                "\",\"processId\":" + processId +
                ",\"environmentRestored\":" + JsonBoolean(environmentRestored) + "}");
            return 1;
        }
    }

    private static string Argument(string[] args, string name)
    {
        string prefix = name + "=";
        foreach (string value in args)
        {
            if (value != null && value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return value.Substring(prefix.Length).Trim();
        }
        return null;
    }

    private static int IntegerArgument(string[] args, string name, int fallback, int minimum, int maximum)
    {
        string value = Argument(args, name);
        int parsed;
        if (value == null || !Int32.TryParse(value, out parsed)) return fallback;
        if (parsed < minimum || parsed > maximum) return fallback;
        return parsed;
    }

    private static EnvironmentSnapshot CaptureDeveloperToolsEnvironment()
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(EnvironmentKeyPath, true))
        {
            string[] names = key.GetValueNames();
            bool existed = Array.Exists(names, name =>
                String.Equals(name, DeveloperToolsVariable, StringComparison.OrdinalIgnoreCase));
            return new EnvironmentSnapshot
            {
                Existed = existed,
                Value = existed ? key.GetValue(DeveloperToolsVariable, null, RegistryValueOptions.DoNotExpandEnvironmentNames) : null,
                Kind = existed ? key.GetValueKind(DeveloperToolsVariable) : RegistryValueKind.String
            };
        }
    }

    private static void SetDeveloperToolsEnvironment(string value)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(EnvironmentKeyPath, true))
            key.SetValue(DeveloperToolsVariable, value, RegistryValueKind.String);
    }

    private static void RestoreDeveloperToolsEnvironment(EnvironmentSnapshot snapshot)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(EnvironmentKeyPath, true))
        {
            if (!snapshot.Existed) key.DeleteValue(DeveloperToolsVariable, false);
            else key.SetValue(DeveloperToolsVariable, snapshot.Value, snapshot.Kind);
        }
    }

    private static uint Activate(string aumid)
    {
        Type type = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"));
        if (type == null) throw new InvalidOperationException("CLAUDE_ACTIVATION_MANAGER_UNAVAILABLE");
        object instance = null;
        try
        {
            instance = Activator.CreateInstance(type);
            IApplicationActivationManager manager = (IApplicationActivationManager)instance;
            uint processId;
            int result = manager.ActivateApplication(aumid, null, 0, out processId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return processId;
        }
        finally
        {
            if (instance != null && Marshal.IsComObject(instance))
                Marshal.FinalReleaseComObject(instance);
        }
    }

    private static void WaitForMainWindow(uint processId, int timeoutMilliseconds, out IntPtr mainWindow)
    {
        Stopwatch timer = Stopwatch.StartNew();
        mainWindow = IntPtr.Zero;
        while (timer.ElapsedMilliseconds < timeoutMilliseconds)
        {
            List<WindowCandidate> windows = WindowsForProcess(processId);
            IntPtr developerToolsWindow = FindDeveloperTools(windows);
            mainWindow = FindMainWindow(windows, developerToolsWindow);
            if (mainWindow != IntPtr.Zero) return;
            Thread.Sleep(250);
        }
    }

    private static IntPtr WaitForDeveloperToolsWindow(uint processId, Stopwatch timer, int timeoutMilliseconds)
    {
        IntPtr developerToolsWindow = IntPtr.Zero;
        while (timer.ElapsedMilliseconds < timeoutMilliseconds)
        {
            List<WindowCandidate> windows = WindowsForProcess(processId);
            developerToolsWindow = FindDeveloperTools(windows);
            if (developerToolsWindow != IntPtr.Zero) return developerToolsWindow;
            Thread.Sleep(250);
        }
        return IntPtr.Zero;
    }

    // Polls the main window's UIA tree until the first-run welcome state has
    // settled. Order of evidence:
    //   1. A real workspace marker already visible  -> no onboarding to do.
    //   2. A Gateway option (AutomationId or EN/TR name on a selectable
    //      control) -> select it, then invoke the localized Continue/Devam.
    //   3. Welcome controls present but NO Gateway option -> fail closed;
    //      a generic Continue is never clicked without Gateway evidence.
    private static void ResolveWelcomeState(
        IntPtr mainWindow,
        Stopwatch timer,
        int timeoutMilliseconds,
        out bool onboardingDetected,
        out string onboardingAction)
    {
        onboardingDetected = false;
        onboardingAction = OnboardingActionNotPresent;
        int welcomeWithoutGatewayPolls = 0;
        while (timer.ElapsedMilliseconds < timeoutMilliseconds)
        {
            if (!IsWindow(mainWindow)) return;
            AutomationElement root = null;
            try { root = AutomationElement.FromHandle(mainWindow); }
            catch { }
            if (root == null) { Thread.Sleep(250); continue; }

            if (HasWorkspaceMarker(root))
            {
                // The main workspace is already present: there is no first-run
                // welcome screen to settle, so no Gateway choice is needed.
                return;
            }

            AutomationElement gateway = FindGatewayOption(root);
            if (gateway != null)
            {
                onboardingDetected = true;
                ActivateControl(gateway, "CLAUDE_WELCOME_GATEWAY_SELECTION_FAILED");
                AutomationElement continueControl = WaitForContinueControl(root, 12000);
                if (continueControl == null && !IsContinueLike(gateway))
                    throw new InvalidOperationException("CLAUDE_WELCOME_CONTINUE_CONTROL_NOT_FOUND");
                if (continueControl != null)
                    ActivateControl(continueControl, "CLAUDE_WELCOME_CONTINUE_ACTIVATION_FAILED");
                onboardingAction = OnboardingActionGatewaySelected;
                return;
            }

            if (FindLoginOrContinueControl(root) != null)
            {
                welcomeWithoutGatewayPolls++;
                // The welcome screen is visible but exposes no Gateway option.
                // Let the tree settle (bounded), then fail closed.
                if (welcomeWithoutGatewayPolls >= 8)
                    throw new InvalidOperationException("CLAUDE_WELCOME_GATEWAY_CONTROL_NOT_FOUND");
            }
            else
            {
                welcomeWithoutGatewayPolls = 0;
            }
            Thread.Sleep(250);
        }
        if (welcomeWithoutGatewayPolls > 0)
            throw new InvalidOperationException("CLAUDE_WELCOME_GATEWAY_CONTROL_NOT_FOUND");
    }

    private static bool WaitForMainWorkspace(IntPtr mainWindow, Stopwatch timer, int timeoutMilliseconds)
    {
        while (timer.ElapsedMilliseconds < timeoutMilliseconds)
        {
            if (!IsWindow(mainWindow)) return false;
            try
            {
                AutomationElement root = AutomationElement.FromHandle(mainWindow);
                if (HasWorkspaceMarker(root)) return true;
            }
            catch { }
            Thread.Sleep(250);
        }
        return false;
    }

    private static bool HasWorkspaceMarker(AutomationElement root)
    {
        AutomationElementCollection elements = root.FindAll(TreeScope.Descendants, NameRelevantCondition);
        for (int index = 0; index < elements.Count; index++)
        {
            string name;
            try { name = elements[index].Current.Name ?? String.Empty; }
            catch { continue; }
            if (ContainsToken(name, WelcomeScreenAutomation.WorkspaceMarkers)) return true;
        }
        return false;
    }

    private static AutomationElement FindGatewayOption(AutomationElement root)
    {
        AutomationElementCollection elements = root.FindAll(TreeScope.Descendants, NameRelevantCondition);
        for (int index = 0; index < elements.Count; index++)
        {
            AutomationElement element = elements[index];
            string id, name;
            ControlType type;
            try
            {
                id = element.Current.AutomationId ?? String.Empty;
                name = element.Current.Name ?? String.Empty;
                type = element.Current.ControlType;
            }
            catch { continue; }
            // AutomationId evidence takes priority regardless of control type.
            if (IsGatewayAutomationId(id)) return element;
            // Name evidence must belong to the Gateway option: a Gateway label
            // on an actually selectable control.
            if (ContainsToken(name, WelcomeScreenAutomation.GatewayNameTokens)
                && IsSelectableControlType(type))
                return element;
        }
        return null;
    }

    // A generic Continue/Devam/Log-in control. Controls whose own name already
    // contains Gateway evidence ("Continue with Gateway", "Gateway ile devam")
    // belong to the Gateway option and are deliberately excluded so a generic
    // Continue is never clicked without a separately verified Gateway choice.
    private static AutomationElement FindContinueControl(AutomationElement root)
    {
        AutomationElementCollection elements = root.FindAll(TreeScope.Descendants, NameRelevantCondition);
        for (int index = 0; index < elements.Count; index++)
        {
            AutomationElement element = elements[index];
            string name;
            ControlType type;
            try
            {
                name = element.Current.Name ?? String.Empty;
                type = element.Current.ControlType;
            }
            catch { continue; }
            if (ContainsToken(name, WelcomeScreenAutomation.ContinueNameTokens)
                && !ContainsToken(name, WelcomeScreenAutomation.GatewayNameTokens)
                && IsSelectableControlType(type))
                return element;
        }
        return null;
    }

    private static AutomationElement FindLoginOrContinueControl(AutomationElement root)
    {
        AutomationElementCollection elements = root.FindAll(TreeScope.Descendants, NameRelevantCondition);
        for (int index = 0; index < elements.Count; index++)
        {
            AutomationElement element = elements[index];
            string name;
            ControlType type;
            try
            {
                name = element.Current.Name ?? String.Empty;
                type = element.Current.ControlType;
            }
            catch { continue; }
            if (ContainsToken(name, WelcomeScreenAutomation.ContinueNameTokens)
                && IsSelectableControlType(type))
                return element;
        }
        return null;
    }

    private static AutomationElement WaitForContinueControl(AutomationElement root, int timeoutMilliseconds)
    {
        Stopwatch timer = Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < timeoutMilliseconds)
        {
            try
            {
                AutomationElement continueControl = FindContinueControl(root);
                if (continueControl != null) return continueControl;
            }
            catch { }
            Thread.Sleep(250);
        }
        return null;
    }

    private static bool IsGatewayAutomationId(string automationId)
    {
        if (String.IsNullOrEmpty(automationId)) return false;
        foreach (string accepted in WelcomeScreenAutomation.GatewayAutomationIds)
        {
            if (String.Equals(automationId, accepted, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    private static bool IsContinueLike(AutomationElement element)
    {
        string name;
        try { name = element.Current.Name ?? String.Empty; }
        catch { return false; }
        return ContainsToken(name, WelcomeScreenAutomation.GatewayNameTokens)
            && ContainsToken(name, WelcomeScreenAutomation.ContinueNameTokens);
    }

    private static bool IsSelectableControlType(ControlType type)
    {
        return type == ControlType.Button
            || type == ControlType.RadioButton
            || type == ControlType.ListItem
            || type == ControlType.CheckBox
            || type == ControlType.Hyperlink
            || type == ControlType.Edit
            || type == ControlType.TabItem;
    }

    private static bool ContainsToken(string value, string[] tokens)
    {
        if (String.IsNullOrEmpty(value)) return false;
        foreach (string token in tokens)
        {
            if (value.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
        return false;
    }

    // Ordered activation: InvokePattern, then SelectionItemPattern, then a
    // last-resort focus + Enter. Any failure fails closed with the supplied
    // code instead of broad-clicking around the welcome screen.
    private static void ActivateControl(AutomationElement element, string failureCode)
    {
        try
        {
            object pattern;
            if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
            {
                ((InvokePattern)pattern).Invoke();
                return;
            }
            if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            {
                ((SelectionItemPattern)pattern).Select();
                return;
            }
            element.SetFocus();
            SendKey(VkReturn);
        }
        catch
        {
            throw new InvalidOperationException(failureCode);
        }
    }

    private static List<WindowCandidate> WindowsForProcess(uint expectedProcessId)
    {
        List<WindowCandidate> windows = new List<WindowCandidate>();
        EnumWindows(delegate (IntPtr window, IntPtr parameter)
        {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId != expectedProcessId || !IsWindowVisible(window)) return true;
            Rect rect;
            if (!GetWindowRect(window, out rect)) return true;
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width < 200 || height < 150) return true;
            StringBuilder title = new StringBuilder(1024);
            GetWindowText(window, title, title.Capacity);
            windows.Add(new WindowCandidate
            {
                Handle = window,
                Title = title.ToString(),
                Width = width,
                Height = height
            });
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    private static bool WaitForVisibleBranding(IntPtr mainWindow, int timeoutMilliseconds)
    {
        Stopwatch timer = Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < timeoutMilliseconds)
        {
            if (!IsWindow(mainWindow)) return false;
            int ciziCodeCount = 0;
            int gatewayCount = 0;
            try
            {
                AutomationElement root = AutomationElement.FromHandle(mainWindow);
                AutomationElementCollection textElements = root.FindAll(
                    TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
                for (int index = 0; index < textElements.Count; index++)
                {
                    string name = textElements[index].Current.Name ?? String.Empty;
                    if (name.IndexOf("Cizi Code", StringComparison.OrdinalIgnoreCase) >= 0)
                        ciziCodeCount++;
                    if (Regex.IsMatch(name, @"\bGateway\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                        gatewayCount++;
                }
                if (ciziCodeCount > 0 && gatewayCount == 0) return true;
            }
            catch { }
            Thread.Sleep(250);
        }
        return false;
    }

    private static IntPtr FindDeveloperTools(List<WindowCandidate> windows)
    {
        foreach (WindowCandidate window in windows)
        {
            string title = window.Title ?? String.Empty;
            if (title.IndexOf("Developer Tools", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("DevTools", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("Geliştirici Araçları", StringComparison.OrdinalIgnoreCase) >= 0)
                return window.Handle;
        }
        if (windows.Count == 2)
        {
            WindowCandidate first = windows[0];
            WindowCandidate second = windows[1];
            long firstArea = (long)first.Width * first.Height;
            long secondArea = (long)second.Width * second.Height;
            return firstArea <= secondArea ? first.Handle : second.Handle;
        }
        return IntPtr.Zero;
    }

    private static IntPtr FindMainWindow(List<WindowCandidate> windows, IntPtr developerToolsWindow)
    {
        WindowCandidate best = null;
        foreach (WindowCandidate window in windows)
        {
            if (window.Handle == developerToolsWindow) continue;
            if (best == null || (long)window.Width * window.Height > (long)best.Width * best.Height)
                best = window;
        }
        return best == null ? IntPtr.Zero : best.Handle;
    }

    private static void FocusWindow(IntPtr window)
    {
        ShowWindow(window, SwRestore);
        BringWindowToTop(window);
        SetForegroundWindow(window);
        SetFocus(window);
        Thread.Sleep(350);
    }

    private static AutomationElement FocusConsolePrompt(IntPtr developerToolsWindow)
    {
        Stopwatch timer = Stopwatch.StartNew();
        AutomationElement root = null;
        AutomationElement consoleControl = null;
        while (timer.ElapsedMilliseconds < 12000)
        {
            try
            {
                root = AutomationElement.FromHandle(developerToolsWindow);
                if (root != null)
                {
                    consoleControl =
                        FindNamedControl(root, ControlType.TabItem, new[] { "Console", "Konsol" }) ??
                        FindNamedControl(root, ControlType.Button, new[] { "Console", "Konsol" });
                    if (consoleControl != null) break;
                }
            }
            catch { }
            Thread.Sleep(250);
        }
        if (root == null) throw new InvalidOperationException("CLAUDE_DEVTOOLS_AUTOMATION_UNAVAILABLE");

        if (consoleControl != null)
        {
            object pattern;
            if (consoleControl.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                ((SelectionItemPattern)pattern).Select();
            else if (consoleControl.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                ((InvokePattern)pattern).Invoke();
            else
                consoleControl.SetFocus();
        }
        else
        {
            // Chromium's platform shortcut opens/focuses the Console even when
            // its localized accessibility label changes.
            SendChord(VkControl, VkShift, VkJ);
        }

        timer.Restart();
        AutomationElement prompt = null;
        while (timer.ElapsedMilliseconds < 10000 && prompt == null)
        {
            AutomationElementCollection edits;
            try
            {
                root = AutomationElement.FromHandle(developerToolsWindow);
                edits = root.FindAll(
                    TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            }
            catch
            {
                Thread.Sleep(250);
                continue;
            }
            for (int index = 0; index < edits.Count; index++)
            {
                AutomationElement candidate = edits[index];
                string name;
                bool keyboardFocusable;
                System.Windows.Rect bounds;
                try
                {
                    name = candidate.Current.Name ?? String.Empty;
                    keyboardFocusable = candidate.Current.IsKeyboardFocusable;
                    bounds = candidate.Current.BoundingRectangle;
                }
                catch
                {
                    continue;
                }
                if (!keyboardFocusable || bounds.Width < 20 || bounds.Height < 10) continue;
                if (name.IndexOf("filter", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("search", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("filtre", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("ara", StringComparison.OrdinalIgnoreCase) >= 0)
                    continue;
                prompt = candidate;
                if (name.IndexOf("console", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("konsol", StringComparison.OrdinalIgnoreCase) >= 0)
                    break;
            }
            if (prompt == null) Thread.Sleep(250);
        }
        if (prompt == null) throw new InvalidOperationException("CLAUDE_DEVTOOLS_CONSOLE_PROMPT_NOT_FOUND");
        prompt.SetFocus();
        Thread.Sleep(350);
        return prompt;
    }

    private static AutomationElement FindNamedControl(
        AutomationElement root,
        ControlType type,
        string[] acceptedNames)
    {
        AutomationElementCollection elements = root.FindAll(
            TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, type));
        for (int index = 0; index < elements.Count; index++)
        {
            string name;
            try { name = elements[index].Current.Name ?? String.Empty; }
            catch { continue; }
            foreach (string accepted in acceptedNames)
            {
                if (String.Equals(name, accepted, StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith(accepted + " ", StringComparison.OrdinalIgnoreCase))
                    return elements[index];
            }
        }
        return null;
    }

    private static void SendKey(ushort key)
    {
        SendInputs(new[] { VirtualKeyInput(key, false), VirtualKeyInput(key, true) });
    }

    private static void SetConsoleScript(AutomationElement prompt, string script)
    {
        object pattern;
        if (!prompt.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            throw new InvalidOperationException("CLAUDE_DEVTOOLS_VALUE_PATTERN_UNAVAILABLE");
        ValuePattern valuePattern = (ValuePattern)pattern;
        if (valuePattern.Current.IsReadOnly)
            throw new InvalidOperationException("CLAUDE_DEVTOOLS_CONSOLE_PROMPT_READ_ONLY");
        valuePattern.SetValue(script);
        Thread.Sleep(350);
    }

    private static void SendChord(ushort modifier1, ushort modifier2, ushort key)
    {
        SendInputs(new[]
        {
            VirtualKeyInput(modifier1, false),
            VirtualKeyInput(modifier2, false),
            VirtualKeyInput(key, false),
            VirtualKeyInput(key, true),
            VirtualKeyInput(modifier2, true),
            VirtualKeyInput(modifier1, true)
        });
        Thread.Sleep(700);
    }

    private static Input VirtualKeyInput(ushort key, bool keyUp)
    {
        return new Input
        {
            Type = InputKeyboard,
            Union = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    VirtualKey = key,
                    ScanCode = 0,
                    Flags = keyUp ? KeyeventfKeyup : 0,
                    Time = 0,
                    ExtraInfo = UIntPtr.Zero
                }
            }
        };
    }

    private static void SendInputs(Input[] inputs)
    {
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
            throw new InvalidOperationException("CLAUDE_DEVTOOLS_INPUT_FAILED");
        Thread.Sleep(8);
    }

    private static string JsonBoolean(bool value)
    {
        return value ? "true" : "false";
    }

    private static string JsonEscape(string value)
    {
        if (String.IsNullOrEmpty(value)) return "CLAUDE_RUNTIME_HOST_FAILED";
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
