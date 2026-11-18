// Headless post-script: for each address in args[1..], find the functions that
// reference it and decompile them (deduped) into args[0]. Use with -process -noanalysis.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.Address;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class DecompRefs extends GhidraScript {
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter w = new PrintWriter(new FileWriter(a[0]));
        ReferenceManager rm = currentProgram.getReferenceManager();
        LinkedHashMap<Function,String> targets = new LinkedHashMap<>();
        for (int i = 1; i < a.length; i++) {
            Address da = toAddr(a[i]);
            w.println("// === refs to " + a[i] + " ===");
            ReferenceIterator ri = rm.getReferencesTo(da);
            int n = 0;
            while (ri.hasNext()) {
                Reference r = ri.next();
                Function f = getFunctionContaining(r.getFromAddress());
                if (f != null) { targets.putIfAbsent(f, a[i]); w.println("//   from " + r.getFromAddress() + " in " + f.getName()); n++; }
            }
            if (n == 0) w.println("//   (no references found)");
        }
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        for (Map.Entry<Function,String> e : targets.entrySet()) {
            Function f = e.getKey();
            w.println("\n//======== " + f.getName() + " @ " + f.getEntryPoint() + "  (ref " + e.getValue() + ") ========");
            DecompileResults r = ifc.decompileFunction(f, 90, monitor);
            if (r != null && r.decompileCompleted()) w.println(r.getDecompiledFunction().getC());
            else w.println("// decompile failed: " + (r != null ? r.getErrorMessage() : "null"));
        }
        ifc.dispose();
        w.close();
        println("DecompRefs wrote " + a[0]);
    }
}
