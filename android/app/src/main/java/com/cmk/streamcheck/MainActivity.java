package com.cmk.streamcheck;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NetProbePlugin.class); // must come before super.onCreate
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
