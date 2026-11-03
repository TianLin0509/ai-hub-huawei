// Synthetic Doctor transport for isolated Hub UI tests. Never used by product.
using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class DoctorFixture {
  static int Main(string[] args) {
    try {
      string action = "", input = "", output = "";
      for (int i = 0; i < args.Length - 1; i++) {
        if (args[i] == "--hub") action = args[++i];
        else if (args[i] == "--in") input = args[++i];
        else if (args[i] == "--out") output = args[++i];
      }
      var serializer = new JavaScriptSerializer();
      var request = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(input));
      var fixtures = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fixture.json")));
      var result = fixtures.ContainsKey(action) ? (Dictionary<string, object>)fixtures[action] : new Dictionary<string, object>();
      result["ok"] = true; result["apiVersion"] = 1; result["doctorVersion"] = "0.0.ui-fixture";
      result["requestId"] = request["requestId"]; result["action"] = action;
      File.WriteAllText(output, serializer.Serialize(result), new System.Text.UTF8Encoding(false));
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 3; }
  }
}
