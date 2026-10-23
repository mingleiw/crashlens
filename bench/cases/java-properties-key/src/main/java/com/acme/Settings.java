package com.acme;

import java.io.IOException;
import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

public class Settings {
    private final Properties props = new Properties();

    public static Settings load() throws IOException {
        Settings settings = new Settings();
        try (Reader reader = Files.newBufferedReader(Path.of("src/main/resources/app.properties"))) {
            settings.props.load(reader);
        }
        return settings;
    }

    public String get(String key) {
        return props.getProperty(key);
    }
}
