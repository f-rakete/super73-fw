// Ghidra headless post-script: seed vector-table functions, then dump
// function list, strings, and decompiled C for every function to args[0].
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.Address;
import java.io.*;

public class DumpAll extends GhidraScript {
    public void run() throws Exception {
        String out = (getScriptArgs().length > 0) ? getScriptArgs()[0]
                     : "C:/Users/Administrator/Desktop/super73-fw/work/ghidra/dump.txt";
        PrintWriter w = new PrintWriter(new FileWriter(out));
        Listing listing = currentProgram.getListing();

        // Seed functions from the Cortex-M vector table (words 1..47 are handler pointers, Thumb bit set).
        try {
            Address base = currentProgram.getMinAddress();
            for (int i = 1; i < 48; i++) {
                Address va = base.add(i * 4L);
                int val = getInt(va);
                if ((val & 1) == 1) {
                    Address ta = toAddr((val & 0xffffffffL) & ~1L);
                    if (currentProgram.getMemory().contains(ta)) {
                        try { disassemble(ta); if (getFunctionAt(ta) == null) createFunction(ta, null); }
                        catch (Exception e) {}
                    }
                }
            }
        } catch (Exception e) { w.println("// seed error: " + e); }

        FunctionManager fm = currentProgram.getFunctionManager();
        w.println("=== FUNCTIONS (" + fm.getFunctionCount() + ") ===");
        for (Function f : fm.getFunctions(true))
            w.println(f.getEntryPoint() + "  " + f.getName() + "  size=" + f.getBody().getNumAddresses());

        w.println("=== STRINGS ===");
        DataIterator di = listing.getDefinedData(true);
        while (di.hasNext()) {
            Data d = di.next();
            if (d.hasStringValue()) w.println(d.getAddress() + "  " + d.getValue());
        }

        w.println("=== DECOMPILATION ===");
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        for (Function f : fm.getFunctions(true)) {
            w.println("//---- " + f.getName() + " @ " + f.getEntryPoint() + " ----");
            DecompileResults r = ifc.decompileFunction(f, 60, monitor);
            if (r != null && r.decompileCompleted()) w.println(r.getDecompiledFunction().getC());
            else w.println("// decompile failed: " + (r != null ? r.getErrorMessage() : "null"));
        }
        ifc.dispose();
        w.close();
        println("DumpAll wrote " + out);
    }
}
