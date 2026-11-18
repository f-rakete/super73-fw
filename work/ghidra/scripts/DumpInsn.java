// Headless post-script: dump instructions (address, raw bytes, disasm) for each
// function entry in args[1..] into args[0]. Use with -process -noanalysis.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.Address;
import java.io.*;

public class DumpInsn extends GhidraScript {
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter w = new PrintWriter(new FileWriter(a[0]));
        for (int i = 1; i < a.length; i++) {
            Address entry = toAddr(a[i]);
            Function f = getFunctionAt(entry);
            if (f == null) { w.println("// no function at " + a[i]); continue; }
            w.println("// ==== " + f.getName() + " @ " + entry + " (" + f.getBody().getNumAddresses() + " bytes) ====");
            InstructionIterator it = currentProgram.getListing().getInstructions(f.getBody(), true);
            while (it.hasNext()) {
                Instruction ins = it.next();
                StringBuilder hx = new StringBuilder();
                for (byte x : ins.getBytes()) hx.append(String.format("%02x ", x));
                w.println(ins.getAddress() + "  " + String.format("%-14s", hx.toString().trim()) + "  " + ins.toString());
            }
        }
        w.close();
        println("DumpInsn wrote " + a[0]);
    }
}
