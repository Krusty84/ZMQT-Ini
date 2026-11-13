/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const javaJarPath = "target/zmqt-apps-jar-with-dependencies.jar";

export function renderPom(
  projectName: string,
  javaRelease: string,
  jeromqVersion: string,
  cborVersion?: string,
): string {
  const cborDependency = cborVersion ? `    <dependency>
      <groupId>com.upokecenter</groupId>
      <artifactId>cbor</artifactId>
      <version>${cborVersion}</version>
    </dependency>
` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.zmqt.generated</groupId>
  <artifactId>${projectName}</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>${javaRelease}</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.zeromq</groupId>
      <artifactId>jeromq</artifactId>
      <version>${jeromqVersion}</version>
    </dependency>
    <dependency>
      <groupId>eu.neilalexander</groupId>
      <artifactId>jnacl</artifactId>
      <version>1.0.0</version>
    </dependency>
    <dependency>
      <groupId>tools.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>3.3.0</version>
    </dependency>
    <dependency>
      <groupId>tools.jackson.core</groupId>
      <artifactId>jackson-core</artifactId>
      <version>3.3.0</version>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-annotations</artifactId>
      <version>2.23</version>
    </dependency>
${cborDependency}  </dependencies>
  <build>
    <finalName>zmqt-apps</finalName>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-resources-plugin</artifactId>
        <version>3.5.0</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.16.0</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.5.5</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-jar-plugin</artifactId>
        <version>3.5.0</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-assembly-plugin</artifactId>
        <version>3.8.0</version>
        <configuration>
          <descriptorRefs><descriptorRef>jar-with-dependencies</descriptorRef></descriptorRefs>
        </configuration>
        <executions>
          <execution>
            <id>assemble-runtime</id>
            <phase>package</phase>
            <goals><goal>single</goal></goals>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
`;
}
